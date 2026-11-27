// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, getErrorMessage } from "./api";
import type { DomDescriptor } from "./types";

describe("api client errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws ApiError with server error text and HTTP metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "コミットする変更がありません" }), {
          status: 409,
          statusText: "Conflict",
          headers: { "content-type": "application/json" },
        })
      )
    );

    let error: unknown;
    try {
      await api.status();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(getErrorMessage(error)).toBe("コミットする変更がありません");
    expect((error as ApiError).status).toBe(409);
    expect((error as ApiError).statusText).toBe("Conflict");
    expect((error as ApiError).serverError).toBe(
      "コミットする変更がありません"
    );
  });

  it("keeps HTTP context when the error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("temporarily unavailable", {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "text/plain" },
        })
      )
    );

    let error: unknown;
    try {
      await api.status();
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(getErrorMessage(error)).toBe("HTTP 503 Service Unavailable");
    expect((error as ApiError).bodyText).toBe("temporarily unavailable");
  });

  it("formats thrown non-Error values predictably for UI messages", () => {
    expect(getErrorMessage("plain failure")).toBe("plain failure");
    expect(getErrorMessage({ error: "structured" })).toBe(
      '{"error":"structured"}'
    );
  });

  it("fetches git status from the git endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ changes: [" M src/App.tsx"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.gitStatus()).resolves.toEqual({
      changes: [" M src/App.tsx"],
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/git/status");
  });

  it("posts git commit messages through the shared JSON client", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.gitCommit("Apply edit")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/git/commit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Apply edit" }),
    });
  });
});

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
        headers: { "content-type": "application/json" },
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
