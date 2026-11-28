import { useEffect, useRef, useState } from "react";
import type { DomDescriptor, ProjectInfo } from "../lib/types.ts";
import { PreviewOverlay } from "./PreviewOverlay.tsx";
import { LOAD_TIMEOUT_MS } from "./AfterPreview.tsx";
import { usePreviewBridge } from "./usePreviewBridge.ts";

interface Props {
  info: ProjectInfo | null;
  selectMode: boolean;
  onSelect: (d: DomDescriptor) => void;
  /** iframe 内で Esc により選択モードが取り消された */
  onCancel?: () => void;
}

/** 中央ペイン: 編集前(HEAD)。要素選択の基準はこちら。 */
export function BeforePreview({ info, selectMode, onSelect, onCancel }: Props) {
  const [candidate, setCandidate] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [manualReload, setManualReload] = useState(0);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const url =
    info?.beforeProxyPort != null
      ? `http://localhost:${info.beforeProxyPort}/`
      : "";
  const [loadFailed, setLoadFailed] = useState(false);
  const beforeError = info?.beforeError || null;
  const errorMessage = beforeError
    ? beforeError
    : loadFailed
    ? "対象アプリに接続できません — 起動ログを確認してください"
    : null;
  const idleStopped = info?.running === false && !errorMessage;
  const { iframeRef } = usePreviewBridge({
    url,
    selectMode,
    acceptSelect: true,
    onSelect,
    onCancel,
    onCandidate: (c) => setCandidate(c.text ? `${c.tag} "${c.text}"` : c.tag),
  });

  useEffect(() => {
    if (!selectMode) setCandidate("");
  }, [selectMode]);

  const clearLoadTimeout = () => {
    if (loadTimeoutRef.current != null) {
      clearTimeout(loadTimeoutRef.current);
      loadTimeoutRef.current = null;
    }
  };

  useEffect(() => {
    clearLoadTimeout();
    setLoaded(false);
    setLoadFailed(false);
    // 停止中(running===false)はタイムアウトを張らず「停止中」表示を接続エラーで上書きしない
    if (!url || info?.running === false) return;

    loadTimeoutRef.current = setTimeout(() => {
      setLoaded(false);
      setLoadFailed(true);
      loadTimeoutRef.current = null;
    }, LOAD_TIMEOUT_MS);

    return clearLoadTimeout;
  }, [url, manualReload, info?.running]);

  return (
    <div className="relative flex h-full w-full flex-col bg-white">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-neutral-800 bg-surface px-3 text-[11px] font-medium text-neutral-300">
        <div className="flex items-center gap-2">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              info?.running
                ? "animate-pulse bg-green-400 motion-reduce:animate-none"
                : "bg-neutral-600"
            }`}
          />
          {info?.running && <span className="sr-only">稼働中</span>}
          <span>編集前 (HEAD)</span>
        </div>
        <div className="flex items-center gap-2">
        {url && (
          <button
            onClick={() => {
              setLoaded(false);
              setLoadFailed(false);
              setManualReload((n) => n + 1);
            }}
            className="rounded-md px-2 py-1 text-[10px] text-neutral-400 hover:bg-raised hover:text-neutral-200"
          >
            再読込
          </button>
        )}
        {info?.gitMode && (
          <span className="text-[10px] text-neutral-500">
            {info.gitMode === "worktree"
              ? "git worktree"
              : info.gitMode === "snapshot"
              ? "スナップショット"
              : "git無し(後と同一)"}
          </span>
        )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {selectMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-accent-600 px-3 py-1 text-xs text-white shadow-lg shadow-accent-950/20">
            選択モード: クリック、または 矢印キーで移動、Enter で選択、Esc で終了
          </div>
        )}
        <div aria-live="polite" className="sr-only">
          {candidate}
        </div>
        {url ? (
          <iframe
            key={manualReload}
            ref={iframeRef}
            src={url}
            title="編集前プレビュー"
            onLoad={() => {
              clearLoadTimeout();
              setLoaded(true);
              setLoadFailed(false);
            }}
            onError={() => setLoadFailed(true)}
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-neutral-950 p-6">
            {errorMessage ? null : (
              <div className="flex max-w-xs flex-col items-center rounded-xl border border-neutral-800 bg-neutral-900/80 px-8 py-7 text-center shadow-xl shadow-black/20">
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800">
                  <div className="h-4 w-6 rounded-sm border border-neutral-500">
                    <div className="mx-auto mt-4 h-px w-3 bg-neutral-500" />
                  </div>
                </div>
                <span className="text-sm leading-6 text-neutral-400">
                  プロジェクトを開くと編集前の画面が表示されます
                </span>
              </div>
            )}
          </div>
        )}
        {errorMessage ? (
          <PreviewOverlay tone="error" message={errorMessage} />
        ) : idleStopped ? (
          <PreviewOverlay
            tone="loading"
            message="停止中です。「開く」で再表示します。"
          />
        ) : url && !loaded ? (
          <PreviewOverlay tone="loading" message="起動中..." />
        ) : null}
      </div>
    </div>
  );
}
