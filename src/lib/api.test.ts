import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import type { DomDescriptor } from "./types.ts";

const descriptor: DomDescriptor = {
  tag: "button",
  classes: [],
  attrs: {},
  domPath: "html>body>button",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api.editStream", () => {
  it("分割された SSE フレームを解析してハンドラを呼び、最終結果を返す", async () => {
    const encoder = new TextEncoder();
    const payload = [
      'data: {"type":"stage","stage":"resolving"}\n\n',
      'data: {"type":"stage","stage":"generating","file":"src/App.tsx"}\n\n',
      'data: {"type":"progress","chars":12,"tail":"updated"}\n\n',
      'data: {"type":"result","ok":true,"proposalId":"p1","diff":"+x"}\n\n',
    ].join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, 17)));
        controller.enqueue(encoder.encode(payload.slice(17, 83)));
        controller.enqueue(encoder.encode(payload.slice(83)));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        })
      )
    );
    const onStage = vi.fn();
    const onProgress = vi.fn();

    const result = await api.editStream(
      { descriptor, instruction: "赤くして" },
      { onStage, onProgress }
    );

    expect(onStage).toHaveBeenNthCalledWith(1, { stage: "resolving" });
    expect(onStage).toHaveBeenNthCalledWith(2, {
      stage: "generating",
      file: "src/App.tsx",
    });
    expect(onProgress).toHaveBeenCalledWith({ chars: 12, tail: "updated" });
    expect(result).toEqual({ ok: true, proposalId: "p1", diff: "+x" });
    expect(fetch).toHaveBeenCalledWith(
      "/api/edit/stream",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ descriptor, instruction: "赤くして" }),
      })
    );
  });

  it("result 受信後は transport EOF を待たず reader を cancel する", async () => {
    const encoder = new TextEncoder();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"result","ok":true,"proposalId":"p1","diff":"+x"}\n\n'
          )
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    );

    await expect(
      api.editStream(
        { descriptor, instruction: "赤くして" },
        { onStage: vi.fn(), onProgress: vi.fn() }
      )
    ).resolves.toMatchObject({ ok: true, proposalId: "p1" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("result イベントなしで終了した場合は明確な日本語エラーにする", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"type":"stage","stage":"resolving"}\n\n')
        );
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    );

    await expect(
      api.editStream(
        { descriptor, instruction: "赤くして" },
        { onStage: vi.fn(), onProgress: vi.fn() }
      )
    ).rejects.toThrow("最終結果を受信できませんでした");
  });
});
