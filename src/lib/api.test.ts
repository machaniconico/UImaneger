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
    expect(getErrorMessage(error)).toBe("サーバでエラーが発生しました（HTTP 503）");
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

describe("api.editCandidate", () => {
  it("選択モデルを候補確定の JSON body に含める", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, proposalId: "p2" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const candidate = { file: "src/App.tsx", line: 4, preview: "x" };

    await api.editCandidate(candidate, descriptor, "赤くして", "claude-haiku-4-5");

    expect(fetchMock).toHaveBeenCalledWith("/api/edit/candidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: "src/App.tsx",
        line: 4,
        descriptor,
        instruction: "赤くして",
        model: "claude-haiku-4-5",
      }),
      signal: expect.any(AbortSignal),
    });
  });
});

describe("api エラー文言(日本語化)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function messageFor(res: Response): Promise<string> {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    try {
      await api.status();
    } catch (e) {
      return getErrorMessage(e);
    }
    return "";
  }

  it("JSON の error フィールドがあれば生 JSON や HTTP prefix を出さずそれだけを出す", async () => {
    const msg = await messageFor(
      new Response(JSON.stringify({ error: "リクエストが大きすぎます" }), { status: 413 })
    );
    expect(msg).toBe("リクエストが大きすぎます");
  });

  it("403 の英語 forbidden は日本語の説明にする", async () => {
    const msg = await messageFor(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 })
    );
    expect(msg).not.toContain("forbidden");
    expect(msg).toMatch(/許可/);
  });

  it("413 で error が無い本文でも生 JSON を出さず日本語にする", async () => {
    const msg = await messageFor(new Response("{}", { status: 413 }));
    expect(msg).not.toContain("{");
    expect(msg).toMatch(/大きすぎ/);
  });

  it("415 の unsupported media type は日本語にする", async () => {
    const msg = await messageFor(
      new Response(JSON.stringify({ error: "unsupported media type" }), { status: 415 })
    );
    expect(msg).not.toMatch(/unsupported/i);
    expect(msg).toMatch(/形式/);
  });

  it("5xx は日本語でステータスを添える", async () => {
    const msg = await messageFor(new Response("boom", { status: 502 }));
    expect(msg).toBe("サーバでエラーが発生しました（HTTP 502）");
  });

  it("成功応答の JSON 解析失敗は日本語にする", async () => {
    const msg = await messageFor(new Response("not json", { status: 200 }));
    expect(msg).not.toMatch(/invalid JSON/i);
    expect(msg).toMatch(/解析できませんでした/);
  });

  it("ネットワーク断(TypeError: Failed to fetch)は接続できない旨の日本語にする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.applyEdit("p1")).rejects.toThrow(/サーバに接続できません/);
    await expect(api.status()).rejects.toThrow(/サーバに接続できません/);
  });
});

describe("api タイムアウト・中断", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function hangingFetch() {
    return vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
  }

  it("状態を変える操作(apply/undo/redo/open/clone)にはタイムアウトも中止も付けない", async () => {
    vi.useFakeTimers();
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    for (const call of [
      () => api.applyEdit("p1"),
      () => api.undoEdit(),
      () => api.redoEdit(),
      () => api.open("/x"),
      () => api.clone("https://example.com/r.git"),
    ]) {
      let settled = false;
      const p = call();
      p.then(
        () => (settled = true),
        () => (settled = true)
      );
      await vi.advanceTimersByTimeAsync(300_000);
      expect(settled).toBe(false);
    }
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.signal).toBeUndefined();
    }
  });

  it("候補確定(生成を伴う)は signal で中止でき、120 秒でタイムアウトする", async () => {
    const candidate = { file: "src/App.tsx", line: 1, preview: "x", reason: "r" } as any;
    vi.stubGlobal("fetch", hangingFetch());
    const ac = new AbortController();
    const aborted = api.editCandidate(candidate, descriptor, "x", undefined, ac.signal);
    ac.abort();
    await expect(aborted).rejects.toMatchObject({ name: "AbortError" });

    vi.useFakeTimers();
    const p = api.editCandidate(candidate, descriptor, "x");
    const assertion = expect(p).rejects.toThrow(/120秒/);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });

  it("status は 10 秒応答が無ければ「サーバに接続できません」でタイムアウトする", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = api.status();
    const assertion = expect(p).rejects.toThrow(/サーバに接続できません/);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("editStream の HTTP 413 + JSON は生 JSON でなく整形済みメッセージにする", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "指示が長すぎます" }), { status: 413 })
      )
    );
    const p = api.editStream(
      { descriptor, instruction: "x" },
      { onStage: vi.fn(), onProgress: vi.fn() }
    );
    await expect(p).rejects.toThrow("指示が長すぎます");
    await p.catch((e) => expect(e.message).not.toContain("{"));
  });

  it("editStream は signal で中断でき AbortError になる", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    );
    const ac = new AbortController();
    const p = api.editStream(
      { descriptor, instruction: "x" },
      { onStage: vi.fn(), onProgress: vi.fn() },
      { signal: ac.signal }
    );
    await Promise.resolve();
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("editStream は 120 秒何も受信しなければ自動で中断してエラーにする", async () => {
    vi.useFakeTimers();
    const stream = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 }))
    );
    const p = api.editStream(
      { descriptor, instruction: "x" },
      { onStage: vi.fn(), onProgress: vi.fn() }
    );
    const assertion = expect(p).rejects.toThrow(/120秒/);
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  });
});
