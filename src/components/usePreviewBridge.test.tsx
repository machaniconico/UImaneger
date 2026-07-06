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
});
