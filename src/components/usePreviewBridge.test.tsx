// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup, act } from "@testing-library/react";
import { usePreviewBridge } from "./usePreviewBridge";
import type { DomDescriptor } from "../lib/types";

const EXPECTED_ORIGIN = "http://preview.test:5174";
const EVIL_ORIGIN = "http://evil.test";

function dispatchMessage(origin: string, data: unknown) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { origin, data })
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
      mountWithIframe({ selectMode: true }, { onCandidate });
      dispatchMessage(EVIL_ORIGIN, { type: "uim:hover-candidate", tag: "h1", text: "x" });
      expect(onCandidate).not.toHaveBeenCalled();
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:hover-candidate", tag: "h1", text: "サンプルアプリ" });
      expect(onCandidate).toHaveBeenCalledWith({ tag: "h1", text: "サンプルアプリ" });
    });

    it("uim:cancel は onCancel を呼び、編集指示欄へフォーカスを戻す", () => {
      vi.useFakeTimers();
      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", "編集指示");
      document.body.appendChild(textarea);
      const onCancel = vi.fn();
      mountWithIframe({ selectMode: true }, { onCancel });
      dispatchMessage(EVIL_ORIGIN, { type: "uim:cancel" });
      expect(onCancel).not.toHaveBeenCalled();
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:cancel" });
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
      mountWithIframe({ selectMode: true });
      dispatchMessage(EXPECTED_ORIGIN, { type: "uim:select", payload: PAYLOAD });
      setTimeout(() => {
        textarea.disabled = false;
      }, 60);
      act(() => {
        vi.advanceTimersByTime(500);
      });
      expect(document.activeElement).toBe(textarea);
      textarea.remove();
    });
  });
});
