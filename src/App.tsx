import { useEffect, useState } from "react";
import type { DomDescriptor, ProjectInfo } from "./lib/types.ts";
import { api } from "./lib/api.ts";
import { ProjectBar } from "./components/ProjectBar.tsx";
import { BeforePreview } from "./components/BeforePreview.tsx";
import { AfterPreview } from "./components/AfterPreview.tsx";
import { Chat } from "./components/Chat.tsx";
import { StatusPanel } from "./components/StatusPanel.tsx";
import { HistoryPanel } from "./components/HistoryPanel.tsx";

const STATUS_RETRY_DELAYS_MS = [500, 1000, 2000];

export function App() {
  const [info, setInfo] = useState<ProjectInfo | null>(null);
  const [hasKey, setHasKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
      if (alive) setError(String((lastError as any)?.message || lastError));
    }

    loadStatus();
    return () => {
      alive = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    setSelected(null);
    setSelectMode(false);
  }, [info?.root]);

  // 編集適用時に右(After)を更新するための合図 (US-005 が dispatch)
  useEffect(() => {
    const onApplied = () => setReloadKey((n) => n + 1);
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
          selectMode={selectMode}
          setSelectMode={setSelectMode}
        />
        {error && (
          <div className="whitespace-pre-wrap border-b border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
            {error}
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
        <HistoryPanel />
        <StatusPanel />
      </aside>

      {/* 中央: 編集前 */}
      <main className="min-w-0 flex-1 border-r border-neutral-800">
        <BeforePreview
          info={info}
          selectMode={selectMode}
          onSelect={onSelect}
        />
      </main>

      {/* 右: 変更後 */}
      <section className="min-w-0 flex-1">
        <AfterPreview info={info} reloadKey={reloadKey} />
      </section>
    </div>
  );
}
