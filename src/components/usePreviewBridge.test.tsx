// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { usePreviewBridge as useRealBridge } from "./usePreviewBridge";
import type { DomDescriptor } from "../lib/types";

const EXPECTED_ORIGIN = "http://preview.test:5174";
const EVIL_ORIGIN = "http://evil.test";

// 受理には「iframe.contentWindow と source が厳密一致」が必要。既定では共有 iframe を使う。
const sharedIframe = document.createElement("iframe");
document.body.appendChild(sharedIframe);

function usePreviewBridge(opts: Parameters<typeof useRealBridge>[0]) {
  const r = useRealBridge(opts);
  const ref = r.iframeRef as { current: HTMLIFrameElement | null };
  if (!ref.current) ref.current = sharedIframe;
  return r;
}

function dispatchMessage(
  origin: string,
  data: unknown,
  source: MessageEventSource | null = sharedIframe.contentWindow
) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { origin, data, source })
    );
  });
}

const PAYLOAD: DomDescriptor = {
  tag: "div",
  id: "hero",
  classes: ["title"],
  attrs: {},
  textSnippet: "Hello",
  domPath: "html>body>div",
};

describe("usePreviewBridge", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("期待originと異なる postMessage は無視し、onSelect は呼ばれない", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      usePreviewBridge({
        url: EXPECTED_ORIGIN,
        selectMode: true,
        acceptSelect: true,
        onSelect,
      })
    );

    dispatchMessage(EVIL_ORIGIN, { type: "uim:select", payload: PAYLOAD });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("期待origin 一致の postMessage は onSelect に payload を渡す", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      usePreviewBridge({
        url: EXPECTED_ORIGIN,
        selectMode: true,
        acceptSelect: true,
        onSelect,
      })
    );

    dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(PAYLOAD);
  });

  it("acceptSelect=false なら期待origin 一致でも onSelect は呼ばれない", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      usePreviewBridge({
        url: EXPECTED_ORIGIN,
        selectMode: true,
        acceptSelect: false,
        onSelect,
      })
    );

    dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("type が uim:select 以外のメッセージは無視する", () => {
    const onSelect = vi.fn();
    renderHook(() =>
      usePreviewBridge({
        url: EXPECTED_ORIGIN,
        selectMode: true,
        acceptSelect: true,
        onSelect,
      })
    );

    dispatchMessage(EXPECTED_ORIGIN, { type: "uim:other", payload: PAYLOAD });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selectMode 通知は期待 origin 宛に送り wildcard は使わない", () => {
    vi.useFakeTimers();
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewBridge({
        url: EXPECTED_ORIGIN,
        selectMode: true,
        acceptSelect: true,
        onSelect: vi.fn(),
      })
    );

    (result.current.iframeRef as { current: HTMLIFrameElement | null }).current =
      iframe;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(postMessage).toHaveBeenCalledWith(
      { type: "uim:setEnabled", value: true },
      EXPECTED_ORIGIN
    );
    expect(postMessage).not.toHaveBeenCalledWith(expect.anything(), "*");
  });

  it("selectMode 通知は origin を確定できない URL では送らない", () => {
    vi.useFakeTimers();
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    const { result } = renderHook(() =>
      usePreviewBridge({
        url: "http://[invalid-url",
        selectMode: true,
        acceptSelect: true,
        onSelect: vi.fn(),
      })
    );

    (result.current.iframeRef as { current: HTMLIFrameElement | null }).current =
      iframe;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(postMessage).not.toHaveBeenCalled();
  });

  describe("keyboard selection", () => {
    function mountWithIframe(initial: { selectMode: boolean }, extra = {}) {
      const iframe = document.createElement("iframe");
      document.body.appendChild(iframe);
      const props = { ...initial, ...extra };
      const hook = renderHook(
        (p: { selectMode: boolean }) =>
          usePreviewBridge({
            url: EXPECTED_ORIGIN,
            selectMode: p.selectMode,
            acceptSelect: true,
            onSelect: vi.fn(),
            ...extra,
          }),
        { initialProps: { selectMode: props.selectMode } }
      );
      (hook.result.current.iframeRef as { current: HTMLIFrameElement | null }).current =
        iframe;
      return { iframe, ...hook };
    }

    it("選択モードに入ると iframe と contentWindow にフォーカスを移す", () => {
      const { iframe, rerender } = mountWithIframe({ selectMode: false });
      const focus = vi.spyOn(iframe, "focus");
      const winFocus = vi.spyOn(iframe.contentWindow!, "focus");
      expect(focus).not.toHaveBeenCalled();
      rerender({ selectMode: true });
      expect(focus).toHaveBeenCalledTimes(1);
      expect(winFocus).toHaveBeenCalledTimes(1);
    });

    it("期待origin の uim:hover-candidate だけ onCandidate に渡す", () => {
      const onCandidate = vi.fn();
      const { iframe } = mountWithIframe({ selectMode: true }, { onCandidate });
      const src = iframe.contentWindow;
      dispatchMessage(EVIL_ORIGIN, { type: "uim:hover-candidate", tag: "h1", text: "x" }, src);
      expect(onCandidate).not.toHaveBeenCalled();
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:hover-candidate", tag: "h1", text: "サンプルアプリ" }, src);
      expect(onCandidate).toHaveBeenCalledWith({ tag: "h1", text: "サンプルアプリ" });
    });

    it("uim:cancel は onCancel を呼び、編集指示欄へフォーカスを戻す", () => {
      vi.useFakeTimers();
      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", "編集指示");
      document.body.appendChild(textarea);
      const onCancel = vi.fn();
      const { iframe } = mountWithIframe({ selectMode: true }, { onCancel });
      dispatchMessage(EVIL_ORIGIN, { type: "uim:cancel" }, iframe.contentWindow);
      expect(onCancel).not.toHaveBeenCalled();
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:cancel" }, iframe.contentWindow);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(document.activeElement).toBe(textarea);
      textarea.remove();
    });

    it("選択確定後は編集指示欄が有効になるのを待ってフォーカスを戻す", () => {
      vi.useFakeTimers();
      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", "編集指示");
      textarea.disabled = true;
      document.body.appendChild(textarea);
      const { iframe } = mountWithIframe({ selectMode: true });
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD }, iframe.contentWindow);
      setTimeout(() => {
        textarea.disabled = false;
      }, 60);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.activeElement).toBe(textarea);
      textarea.remove();
    });

    it("[1] source が null または別 window のメッセージは期待 origin でも無視する", () => {
      const onSelect = vi.fn();
      const onCancel = vi.fn();
      const onCandidate = vi.fn();
      const { iframe } = mountWithIframe({ selectMode: true }, { onSelect, onCancel, onCandidate });
      const other = document.createElement("iframe");
      document.body.appendChild(other);
      for (const src of [null, other.contentWindow, window]) {
        dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD }, src);
        dispatchMessage(EXPECTED_ORIGIN, { type: "uim:cancel" }, src);
        dispatchMessage(EXPECTED_ORIGIN, { type: "uim:hover-candidate", tag: "h1", text: "x" }, src);
      }
      expect(onSelect).not.toHaveBeenCalled();
      expect(onCancel).not.toHaveBeenCalled();
      expect(onCandidate).not.toHaveBeenCalled();
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD }, iframe.contentWindow);
      expect(onSelect).toHaveBeenCalledTimes(1);
    });

    it("[1] iframe 未マウントなら期待 origin でも受理しない", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() =>
        useRealBridge({ url: EXPECTED_ORIGIN, selectMode: true, acceptSelect: true, onSelect })
      );
      expect(result.current.iframeRef.current).toBeNull();
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD }, null);
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD }, window);
      expect(onSelect).not.toHaveBeenCalled();
    });

    it("[2] 選択モード外の uim:cancel / uim:hover-candidate は無視しフォーカスも動かさない", () => {
      vi.useFakeTimers();
      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", "編集指示");
      document.body.appendChild(textarea);
      const onCancel = vi.fn();
      const onCandidate = vi.fn();
      const { iframe, rerender } = mountWithIframe({ selectMode: true }, { onCancel, onCandidate });
      rerender({ selectMode: false });
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:cancel" }, iframe.contentWindow);
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:hover-candidate", tag: "h1", text: "x" }, iframe.contentWindow);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(onCancel).not.toHaveBeenCalled();
      expect(onCandidate).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(textarea);
      textarea.remove();
    });

    it("[6] 未選択 Esc 後に再選択すると古いフォーカス復帰タイマーは解除される", () => {
      vi.useFakeTimers();
      const btn = document.createElement("button");
      btn.setAttribute("data-uim-select-button", "");
      document.body.appendChild(btn);
      const ta = document.createElement("textarea");
      ta.setAttribute("aria-label", "編集指示");
      ta.disabled = true;
      document.body.appendChild(ta);
      const { iframe, rerender } = mountWithIframe({ selectMode: true });
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:cancel" }, iframe.contentWindow);
      rerender({ selectMode: false });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender({ selectMode: true }); // 再選択
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(document.activeElement).not.toBe(btn);
      btn.remove();
      ta.remove();
    });

    it("[6] unmount 後はフォーカス復帰タイマーが動かない", () => {
      vi.useFakeTimers();
      const btn = document.createElement("button");
      btn.setAttribute("data-uim-select-button", "");
      document.body.appendChild(btn);
      const ta = document.createElement("textarea");
      ta.setAttribute("aria-label", "編集指示");
      ta.disabled = true;
      document.body.appendChild(ta);
      const { iframe, unmount } = mountWithIframe({ selectMode: true });
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:cancel" }, iframe.contentWindow);
      unmount();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(document.activeElement).not.toBe(btn);
      btn.remove();
      ta.remove();
    });

    it("[7] 候補テキストの双方向制御文字・制御文字は受信側でも除去する", () => {
      const onCandidate = vi.fn();
      const { iframe } = mountWithIframe({ selectMode: true }, { onCandidate });
      dispatchMessage(
        EXPECTED_ORIGIN,
        { type: "uim:hover-candidate", tag: "h1\u202E", text: "a\u202Eb\u2066c\u200Fd\u0007e\u009Ff" },
        iframe.contentWindow
      );
      expect(onCandidate).toHaveBeenCalledWith({ tag: "h1", text: "abcdef" });
    });
  });
});
