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
    // プレビュー iframe の期待 origin(before/after プロキシの origin) を算出
    let expectedOrigin: string | null = null;
    try {
      expectedOrigin = url ? new URL(url, window.location.origin).origin : null;
    } catch {
      expectedOrigin = null;
    }
    function handler(e: MessageEvent) {
      // origin 不一致(および origin 不明)のメッセージは無視
      if (!expectedOrigin || e.origin !== expectedOrigin) return;
      // さらに source が期待 iframe と一致するか検証 (iframe 未マウント時は origin のみで判定)
      const iframe = iframeRef.current;
      if (iframe && e.source && e.source !== iframe.contentWindow) return;
      const d = e.data || {};
      if (d.type === "uim:select" && d.payload) {
        onSelect?.(d.payload as DomDescriptor);
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [acceptSelect, onSelect, url]);

  useEffect(() => {
    let targetOrigin: string | null = null;
    try {
      targetOrigin = url ? new URL(url, window.location.origin).origin : null;
    } catch {
      targetOrigin = null;
    }
    const send = () => {
      if (!targetOrigin) return;
      iframeRef.current?.contentWindow?.postMessage(
        { type: "uim:setEnabled", value: selectMode },
        targetOrigin
      );
    };
    send();
    const t = setInterval(send, 1000);
    return () => clearInterval(t);
  }, [selectMode, url]);

  return { iframeRef };
}
