import { useEffect, useRef, useState } from "react";
import type { DomDescriptor, ProjectInfo } from "./lib/types.ts";
import { api, getErrorMessage } from "./lib/api.ts";
import { SERVER_UNREACHABLE_MESSAGE, isNetworkError } from "./lib/network.ts";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { BeforePreview } from "./components/BeforePreview.tsx";
import { AfterPreview } from "./components/AfterPreview.tsx";
import { Chat } from "./components/Chat.tsx";
import { GitPanel } from "./components/GitPanel.tsx";
import { StatusPanel } from "./components/StatusPanel.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";

const STATUS_RETRY_DELAYS_MS = [500, 1000, 2000];

/** dev server が HMR で変更を反映するフレームワーク(server/lib/runner.ts の plan.framework と一致させる) */
const HMR_FRAMEWORKS = new Set([
  "Vite",
  "Next.js",
  "Nuxt",
  "SvelteKit",
  "Astro",
  "Angular",
  "Vue CLI",
  "Create React App",
  "Remix",
  "React Router",
]);

/**
 * 適用後の更新を dev server の HMR に任せてよいか。React Router / Remix は `dev` script が無いと
 * `start` script(本番サーバのことが多く HMR が無い)で起動するため、その場合は再読込する。
 */
export function hasDevServerHmr(framework: string | undefined, runCommand = ""): boolean {
  if (framework === undefined || !HMR_FRAMEWORKS.has(framework)) return false;
  return !/(?:^|\s)run\s+start\s*$/.test(runCommand);
}

export function App() {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  // 起動時のステータス取得に失敗した状態(再試行ボタンを出す)
  const [startupFailed, setStartupFailed] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<DomDescriptor | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          resolve();
        }, ms);
      });

    async function loadStatus() {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= STATUS_RETRY_DELAYS_MS.length; attempt++) {
        try {
          const s = await api.status();
          if (!alive) return;
          setInfo(s.info);
          setHasKey(s.hasKey);
          setError("");
          setStartupFailed(false);
          return;
        } catch (e) {
          lastError = e;
          if (!alive) return;
          const delay = STATUS_RETRY_DELAYS_MS[attempt];
          if (delay == null) break;
          await wait(delay);
          if (!alive) return;
        }
      }
      if (alive) {
        setError(
          isNetworkError(lastError)
            ? SERVER_UNREACHABLE_MESSAGE
            : getErrorMessage(lastError)
        );
        setStartupFailed(true);
      }
    }

    loadStatus();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [loadNonce]);

  useEffect(() => {
    setSelected(null);
    setSelectMode(false);
  }, [info?.root]);

  // 編集適用・undo 時に右(After)を更新するための合図 (US-005 が dispatch)。
  // HMR のある dev server では iframe を作り直さず、既に接続済みの HMR に更新を任せる。
  // 作り直すと、ファイル監視の通知が遅い環境(macOS の fsevents 等)で古いモジュールを受け取り、
  // 新しい iframe の HMR 接続前に来た更新も取りこぼして古い表示のまま残ることがあった。
  // HMR の無い構成(Django、静的 HTML など)は従来どおり再読込する。
  const hmrRef = useRef(false);
  hmrRef.current = hasDevServerHmr(info?.framework, info?.runCommand);
  useEffect(() => {
    const onApplied = () => {
      if (hmrRef.current) return;
      setReloadKey((n) => n + 1);
    };
    window.addEventListener("uim:applied", onApplied);
    return () => window.removeEventListener("uim:applied", onApplied);
  }, []);

  function onSelect(d: DomDescriptor) {
    setSelected(d);
    setSelectMode(false);
  }

  return (
    <div className="flex h-full bg-base text-neutral-200">
      {/* 左: GUI 操作パネル */}
      <aside className="flex w-[340px] shrink-0 flex-col border-r border-neutral-800 bg-surface">
        <ProjectBar
          info={info}
          hasKey={hasKey}
          busy={busy}
          setBusy={setBusy}
          onInfo={setInfo}
          onError={setError}
          onWarning={setWarning}
          selectMode={selectMode}
          setSelectMode={setSelectMode}
        />
        {error && (
          <div
            role="alert"
            className="flex items-start justify-between gap-2 whitespace-pre-wrap border-b border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300"
          >
            <span>{error}</span>
            {startupFailed && (
              <button
                type="button"
                onClick={() => {
                  setError("");
                  setStartupFailed(false);
                  setLoadNonce((n) => n + 1);
                }}
                className="shrink-0 rounded-md border border-red-800 px-2 py-0.5 text-[11px] text-red-200 hover:bg-red-900"
              >
                再試行
              </button>
            )}
          </div>
        )}
        {warning && (
          <div
            role="status"
            className="whitespace-pre-wrap border-b border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300"
          >
            {warning}
          </div>
        )}
        <div className="min-h-0 flex-1">
          <Chat
            key={info?.root ?? "none"}
            selected={selected}
            hasKey={hasKey}
            selectionModeActive={selectMode}
            onDeselect={() => {
              setSelected(null);
              setSelectMode(false);
            }}
          />
        </div>
        <GitPanel info={info} />
        <HistoryPanel root={info?.root} />
        <StatusPanel />
      </aside>

      {/* 中央: 編集前 */}
      <main className="min-w-0 flex-1 border-r border-neutral-800">
        <BeforePreview
          info={info}
          selectMode={selectMode}
          onSelect={onSelect}
          onCancel={() => setSelectMode(false)}
        />
      </main>

      {/* 右: 変更後 */}
      <section className="min-w-0 flex-1">
        <AfterPreview info={info} reloadKey={reloadKey} />
      </section>
    </div>
  );
}
