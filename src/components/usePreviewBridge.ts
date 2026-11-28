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
  /** iframe 内で Esc により選択モードが取り消された */
  onCancel?: () => void;
  /** キーボード移動で候補が変わった(スクリーンリーダー向けの短い説明用) */
  onCandidate?: (c: { tag: string; text: string }) => void;
}

/** 選択確定/取消後に Chat の指示入力欄へフォーカスを戻す。入力欄が有効になるのを短く待つ。 */
function restoreFocusToChat() {
  let tries = 0;
  const attempt = () => {
    const ta = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="編集指示"]'
    );
    if (ta && !ta.disabled) {
      ta.focus();
      return;
    }
    if (++tries < 8) {
      setTimeout(attempt, 50);
      return;
    }
    // 要素未選択のまま取り消した場合は「要素を選択」ボタンへ戻す
    document
      .querySelector<HTMLElement>("[data-uim-select-button]")
      ?.focus();
  };
  setTimeout(attempt, 0);
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
  onCancel,
  onCandidate,
}: Options) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 選択モードに入った瞬間にキーボード操作を続けられるよう iframe へフォーカスを移す
  const wasSelectMode = useRef(false);
  useEffect(() => {
    if (selectMode && !wasSelectMode.current) {
      const iframe = iframeRef.current;
      iframe?.focus();
      iframe?.contentWindow?.focus();
    }
    wasSelectMode.current = selectMode;
  }, [selectMode]);

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
        restoreFocusToChat();
      } else if (d.type === "uim:cancel") {
        onCancel?.();
        restoreFocusToChat();
      } else if (
        d.type === "uim:hover-candidate" &&
        typeof d.tag === "string" &&
        typeof d.text === "string"
      ) {
        onCandidate?.({ tag: d.tag.slice(0, 32), text: d.text.slice(0, 80) });
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [acceptSelect, onSelect, onCancel, onCandidate, url]);

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
