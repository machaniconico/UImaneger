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
function restoreFocusToChat(): () => void {
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = () => {
    timer = null;
    const ta = document.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="編集指示"]'
    );
    if (ta && !ta.disabled) {
      ta.focus();
      return;
    }
    if (++tries < 8) {
      timer = setTimeout(attempt, 50);
      return;
    }
    // 要素未選択のまま取り消した場合は「要素を選択」ボタンへ戻す
    document
      .querySelector<HTMLElement>("[data-uim-select-button]")
      ?.focus();
  };
  timer = setTimeout(attempt, 0);
  return () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
}

/** 候補テキストから制御文字・双方向制御文字を除く(読み上げ領域・表示の汚染防止) */
function stripUnsafeText(v: string): string {
  return v.replace(
    // 制御文字、ALM(U+061C)、ゼロ幅・方向マーク(U+200B-200F)、埋め込み/上書き(U+202A-202E)、
    // 不可視演算子・方向分離(U+2060-206F)、BOM(U+FEFF)
    /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g,
    ""
  );
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
  const selectModeRef = useRef(selectMode);
  selectModeRef.current = selectMode;
  const cancelRestoreRef = useRef<(() => void) | null>(null);
  const startRestore = () => {
    cancelRestoreRef.current?.();
    cancelRestoreRef.current = restoreFocusToChat();
  };
  useEffect(
    () => () => {
      cancelRestoreRef.current?.();
      cancelRestoreRef.current = null;
    },
    []
  );
  useEffect(() => {
    if (selectMode && !wasSelectMode.current) {
      // 新しい選択開始: 前回の取消・確定に伴うフォーカス復帰を取り消す
      cancelRestoreRef.current?.();
      cancelRestoreRef.current = null;
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
      // source が現在の iframe.contentWindow と厳密一致するものだけ受理(未マウント・null は拒否)
      const frameWindow = iframeRef.current?.contentWindow;
      if (!frameWindow || e.source !== frameWindow) return;
      const d = e.data || {};
      // 選択モードを抜けた後に遅れて届いた選択は確定しない
      if (d.type === "uim:select" && d.payload && selectModeRef.current) {
        onSelect?.(d.payload as DomDescriptor);
        startRestore();
      } else if (d.type === "uim:cancel" && selectModeRef.current) {
        onCancel?.();
        startRestore();
      } else if (
        d.type === "uim:hover-candidate" &&
        selectModeRef.current &&
        typeof d.tag === "string" &&
        typeof d.text === "string"
      ) {
        onCandidate?.({
          tag: stripUnsafeText(d.tag).slice(0, 32),
          text: stripUnsafeText(d.text).slice(0, 80),
        });
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
