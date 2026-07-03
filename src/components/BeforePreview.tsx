import { useEffect, useState } from "react";
import type { DomDescriptor, ProjectInfo } from "../lib/types.ts";
import { PreviewOverlay } from "./PreviewOverlay.tsx";
import { usePreviewBridge } from "./usePreviewBridge.ts";

interface Props {
  info: ProjectInfo | null;
  selectMode: boolean;
  onSelect: (d: DomDescriptor) => void;
}

/** 中央ペイン: 編集前(HEAD)。要素選択の基準はこちら。 */
export function BeforePreview({ info, selectMode, onSelect }: Props) {
  const [loaded, setLoaded] = useState(false);
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
  });

  useEffect(() => {
    setLoaded(false);
    setLoadFailed(false);
  }, [url]);

  return (
    <div className="relative flex h-full w-full flex-col bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
        <span>編集前 (HEAD)</span>
        {info?.gitMode && (
          <span className="text-neutral-400">
            {info.gitMode === "worktree"
              ? "git worktree"
              : info.gitMode === "snapshot"
              ? "スナップショット"
              : "git無し(後と同一)"}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">
        {selectMode && (
          <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full bg-blue-600 px-3 py-1 text-xs text-white shadow">
            選択モード: 変更したい要素をクリック
          </div>
        )}
        {url ? (
          <iframe
            ref={iframeRef}
            src={url}
            title="before"
            onLoad={() => setLoaded(true)}
            onError={() => setLoadFailed(true)}
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            {errorMessage
              ? null
              : "プロジェクトを開くと編集前の画面が表示されます"}
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
