import { useState } from "react";
import type { ProjectInfo } from "../lib/types.ts";
import { usePreviewBridge } from "./usePreviewBridge.ts";

interface Props {
  info: ProjectInfo | null;
  /** 編集適用のたびに変えると iframe を強制リロードする */
  reloadKey?: number;
}

/** 右ペイン: 変更後(作業ツリー)。閲覧専用のライブプレビュー。 */
export function AfterPreview({ info, reloadKey = 0 }: Props) {
  const [manualReload, setManualReload] = useState(0);
  const url =
    info?.afterProxyPort != null
      ? `http://localhost:${info.afterProxyPort}/`
      : "";
  const { iframeRef } = usePreviewBridge({
    url,
    selectMode: false,
    acceptSelect: false,
  });

  return (
    <div className="relative flex h-full w-full flex-col bg-white">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-600">
        <span>変更後 (ライブ)</span>
        {url && (
          <button
            onClick={() => setManualReload((n) => n + 1)}
            className="rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-200"
          >
            再読込
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {url ? (
          <iframe
            key={`${reloadKey}-${manualReload}`}
            ref={iframeRef}
            src={url}
            title="after"
            className="h-full w-full border-0"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            変更後のプレビュー
          </div>
        )}
      </div>
    </div>
  );
}
