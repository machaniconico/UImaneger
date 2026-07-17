import { useEffect, useRef, useState } from "react";
import type { ProjectInfo } from "../lib/types.ts";
import { PreviewOverlay } from "./PreviewOverlay.tsx";
import { usePreviewBridge } from "./usePreviewBridge.ts";

export const LOAD_TIMEOUT_MS = 15000;

interface Props {
  info: ProjectInfo | null;
  /** 編集適用のたびに変えると iframe を強制リロードする */
  reloadKey?: number;
}

/** 右ペイン: 変更後(作業ツリー)。閲覧専用のライブプレビュー。 */
export function AfterPreview({ info, reloadKey = 0 }: Props) {
  const [manualReload, setManualReload] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const url =
    info?.afterProxyPort != null
      ? `http://localhost:${info.afterProxyPort}/`
      : "";
  const errorMessage = loadFailed
    ? "対象アプリに接続できません — 起動ログを確認してください"
    : null;
  const idleStopped = info?.running === false && !errorMessage;
  const { iframeRef } = usePreviewBridge({
    url,
    selectMode: false,
    acceptSelect: false,
  });

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
    // 停止中(running===false)はタイムアウトを張らない。バックエンドの
    // teardown 順序に依存せず「停止中」表示を接続エラーに誤って上書きさせない。
    if (!url || info?.running === false) return;

    loadTimeoutRef.current = setTimeout(() => {
      setLoaded(false);
      setLoadFailed(true);
      loadTimeoutRef.current = null;
    }, LOAD_TIMEOUT_MS);

    return clearLoadTimeout;
  }, [url, reloadKey, manualReload, info?.running]);

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
          <span>変更後 (ライブ)</span>
        </div>
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
      </div>
      <div className="relative min-h-0 flex-1">
        {url ? (
          <iframe
            key={`${reloadKey}-${manualReload}`}
            ref={iframeRef}
            src={url}
            title="after"
            onLoad={() => {
              clearLoadTimeout();
              setLoaded(true);
              setLoadFailed(false);
            }}
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-neutral-950 p-6">
            <div className="flex max-w-xs flex-col items-center rounded-xl border border-neutral-800 bg-neutral-900/80 px-8 py-7 text-center shadow-xl shadow-black/20">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800">
                <div className="h-4 w-6 rounded-sm border border-neutral-500">
                  <div className="mx-auto mt-4 h-px w-3 bg-neutral-500" />
                </div>
              </div>
              <span className="text-sm leading-6 text-neutral-400">
                プロジェクトを開くと変更後のプレビューが表示されます
              </span>
            </div>
          </div>
        )}
        {errorMessage ? (
          <PreviewOverlay tone="error" message={errorMessage} />
        ) : idleStopped ? (
          <PreviewOverlay tone="loading" message="停止中です…" />
        ) : url && !loaded ? (
          <PreviewOverlay tone="loading" message="起動中..." />
        ) : null}
      </div>
    </div>
  );
}
