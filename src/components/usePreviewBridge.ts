import { useEffect, useRef } from "react";
import type { DomDescriptor } from "../lib/types.ts";

interface Options {
  /** プロキシURL (null ならプレビュー無し) */
  url: string;
  /** 選択モードを有効にするか (after 側は false にして閲覧専用にできる) */
  selectMode: boolean;
  /** 選択を受け取れるか (false なら uim:select を無視) */
  acceptSelect: boolean;
  onSelect?: (d: DomDescriptor) => void;
}

/**
 * iframe(対象プロキシ) との postMessage ブリッジ。
 * - uim:select を受信して onSelect に渡す
 * - 選択モードを iframe に通知 (HMR 再読込後も維持するため定期送信)
 */
export function usePreviewBridge({
  url,
  selectMode,
  acceptSelect,
  onSelect,
}: Options) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!acceptSelect) return;
    function handler(e: MessageEvent) {
      const d = e.data || {};
      if (d.type === "uim:select" && d.payload) {
        onSelect?.(d.payload as DomDescriptor);
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [acceptSelect, onSelect]);

  useEffect(() => {
    const send = () =>
      iframeRef.current?.contentWindow?.postMessage(
        { type: "uim:setEnabled", value: selectMode },
        "*"
      );
    send();
    const t = setInterval(send, 1000);
    return () => clearInterval(t);
  }, [selectMode, url]);

  return { iframeRef };
}
