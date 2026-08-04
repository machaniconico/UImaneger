// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, getErrorMessage } from "./api";

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
