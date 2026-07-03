// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { api, __stores } from "./api.ts";
import * as state from "../lib/state.ts";
import { openProject, stopProject } from "../lib/state.ts";
import type { DomDescriptor } from "../lib/types.ts";

const claudeMock = vi.hoisted(() => {
  class TruncatedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TruncatedError";
    }
  }

  return {
    complete: vi.fn(),
    TruncatedError,
  };
});

vi.mock("../lib/claude.ts", () => ({
  complete: claudeMock.complete,
  hasKey: () => true,
  stripCodeFence: (text: string) => {
    const m = text.match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)^```/m);
    if (!m) return text.trim();
    return m[1].replace(/\r?\n$/, "");
  },
  TruncatedError: claudeMock.TruncatedError,
}));

const app = new Hono();
app.route("/api", api);

const originalContent = [
  "import React from \"react\";",
  "",
  "export function App() {",
  "  const label = \"Save now\";",
  "",
  "  return (",
  "    <main>",
  "      <button id=\"save-button\" className=\"primary-action\">",
  "        {label}",
  "      </button>",
  "    </main>",
  "  );",
  "}",
].join("\n");

const editedContent = originalContent.replace(
  "const label = \"Save now\";",
  "const label = \"Saved successfully\";"
);

interface JsonResponse<T = Record<string, unknown>> {
  res: Response;
  body: T;
}

interface ProposalBody {
  ok: true;
  proposalId: string;
  file: string;
  relFile: string;
  line?: number;
  confidence: string;
  diff: string;
}

let root: string;
let filePath: string;

function descriptorFor(fileName: string): DomDescriptor {
  return {
    tag: "button",
    id: "save-button",
    classes: ["primary-action"],
    attrs: {
      id: "save-button",
      class: "primary-action",
    },
    textSnippet: "Save now",
    domPath: "#save-button",
    source: {
      fileName,
      lineNumber: 8,
      columnNumber: 7,
    },
  };
}

async function postJson<T = Record<string, unknown>>(
  path: string,
  body: unknown
): Promise<JsonResponse<T>> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    res,
    body: (await res.json()) as T,
  };
}

async function getJson<T = Record<string, unknown>>(
  path: string
): Promise<JsonResponse<T>> {
  const res = await app.request(path);
  return {
    res,
    body: (await res.json()) as T,
  };
}

async function requestProposal(proposed = editedContent): Promise<ProposalBody> {
  claudeMock.complete.mockResolvedValueOnce(proposed);
  const { res, body } = await postJson<ProposalBody>("/api/edit", {
    descriptor: descriptorFor(filePath),
    instruction: "Change the button label.",
  });

  expect(res.status).toBe(200);
  expect(body.ok).toBe(true);
  return body;
}

beforeEach(async () => {
  claudeMock.complete.mockReset();
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);

  root = mkdtempSync(join(tmpdir(), "uim-api-"));
  mkdirSync(join(root, "src"), { recursive: true });
  filePath = join(root, "src", "App.tsx");
  writeFileSync(filePath, originalContent, "utf8");

  await openProject(root, { command: "echo test-server-ready" });
});

afterEach(async () => {
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  await stopProject();
  rmSync(root, { recursive: true, force: true });
});

describe("edit proposal API", () => {
  it("creates a proposal with a unified diff without changing the file", async () => {
    const proposal = await requestProposal();

    expect(proposal).toMatchObject({
      ok: true,
      file: filePath,
      relFile: "src/App.tsx",
      confidence: "high",
    });
    expect(typeof proposal.proposalId).toBe("string");
    expect(proposal.proposalId.length).toBeGreaterThan(0);
    expect(proposal.diff).toContain("--- a/src/App.tsx");
    expect(proposal.diff).toContain("+++ b/src/App.tsx");
    expect(proposal.diff).toContain("@@");
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("remaps before-preview source paths back to the real project root", async () => {
    const beforeDir = mkdtempSync(join(tmpdir(), "uim-before-route-"));
    const beforeFile = join(beforeDir, relative(root, filePath));
    mkdirSync(dirname(beforeFile), { recursive: true });
    writeFileSync(beforeFile, originalContent, "utf8");
    const getBeforeSpy = vi.spyOn(state, "getBefore").mockReturnValue({
      dir: beforeDir,
      root,
      mode: "snapshot",
    });
    try {
      claudeMock.complete.mockResolvedValueOnce(editedContent);
      const { res, body } = await postJson<ProposalBody>("/api/edit", {
        descriptor: descriptorFor(beforeFile),
        instruction: "Change the button label.",
      });

      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.file).toBe(filePath);
      expect(body.relFile).toBe("src/App.tsx");
    } finally {
      getBeforeSpy.mockRestore();
      rmSync(beforeDir, { recursive: true, force: true });
    }
  });

  it("applies an accepted proposal to the real file", async () => {
    const proposal = await requestProposal();

    const { res, body } = await postJson<{ ok: true; relFile: string }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, relFile: "src/App.tsx" });
    expect(readFileSync(filePath, "utf8")).toBe(editedContent);
  });

  it("reports undoDepth through apply, status, and undo", async () => {
    const proposal = await requestProposal();

    const applied = await postJson<{ ok: true; undoDepth: number }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );
    expect(applied.res.status).toBe(200);
    expect(applied.body.undoDepth).toBe(1);

    const status = await getJson<{ undoDepth: number }>("/api/status");
    expect(status.res.status).toBe(200);
    expect(status.body.undoDepth).toBe(1);

    const undone = await postJson<{ ok: true; undoDepth: number }>(
      "/api/edit/undo",
      {}
    );
    expect(undone.res.status).toBe(200);
    expect(undone.body.undoDepth).toBe(0);

    const statusAfterUndo = await getJson<{ undoDepth: number }>("/api/status");
    expect(statusAfterUndo.res.status).toBe(200);
    expect(statusAfterUndo.body.undoDepth).toBe(0);
  });

  it("undoes the last applied proposal", async () => {
    const proposal = await requestProposal();
    await postJson("/api/edit/apply", { proposalId: proposal.proposalId });

    const { res, body } = await postJson<{ ok: true; relFile: string }>(
      "/api/edit/undo",
      {}
    );

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, relFile: "src/App.tsx" });
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("refuses undo when the file changed after apply and keeps the undo entry", async () => {
    const proposal = await requestProposal();
    await postJson("/api/edit/apply", { proposalId: proposal.proposalId });
    const drifted = editedContent.replace("Saved successfully", "Changed later");
    writeFileSync(filePath, drifted, "utf8");

    const firstUndo = await postJson<{ error: string }>("/api/edit/undo", {});
    expect(firstUndo.res.status).toBe(409);
    expect(firstUndo.body.error).toBe(
      "適用後にファイルが変更されているため取り消せません。"
    );
    expect(readFileSync(filePath, "utf8")).toBe(drifted);

    writeFileSync(filePath, editedContent, "utf8");
    const secondUndo = await postJson<{ ok: true; undoDepth: number }>(
      "/api/edit/undo",
      {}
    );
    expect(secondUndo.res.status).toBe(200);
    expect(secondUndo.body.undoDepth).toBe(0);
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("clears edit stores after opening a different project", async () => {
    const proposal = await requestProposal();
    const applied = await postJson<{ ok: true; undoDepth: number }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );
    expect(applied.body.undoDepth).toBe(1);

    const oldRoot = root;
    const nextRoot = mkdtempSync(join(tmpdir(), "uim-api-next-"));
    mkdirSync(join(nextRoot, "src"), { recursive: true });
    writeFileSync(join(nextRoot, "src", "App.tsx"), originalContent, "utf8");
    await openProject(nextRoot, { command: "echo test-server-ready" });
    root = nextRoot;
    filePath = join(nextRoot, "src", "App.tsx");
    rmSync(oldRoot, { recursive: true, force: true });

    const status = await getJson<{ undoDepth: number }>("/api/status");
    expect(status.res.status).toBe(200);
    expect(status.body.undoDepth).toBe(0);

    const undo = await postJson<{ error: string }>("/api/edit/undo", {});
    expect(undo.res.status).toBe(404);
    expect(undo.body.error).toContain("元に戻せる適用がありません");
  });

  it("rejects a proposal and refuses to apply it afterwards", async () => {
    const proposal = await requestProposal();

    const rejected = await postJson<{ ok: true }>("/api/edit/reject", {
      proposalId: proposal.proposalId,
    });
    expect(rejected.res.status).toBe(200);
    expect(rejected.body).toEqual({ ok: true });

    const apply = await postJson<{ error: string }>("/api/edit/apply", {
      proposalId: proposal.proposalId,
    });
    expect(apply.res.status).toBe(404);
    expect(apply.body.error).toMatch(/提案が見つかりません|not found/i);
  });

  it("refuses to apply a proposal when the file changed after proposal creation", async () => {
    const proposal = await requestProposal();
    const externallyEdited = originalContent.replace(
      "Save now",
      "External change"
    );
    writeFileSync(filePath, externallyEdited, "utf8");

    const { res, body } = await postJson<{ error: string }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/変更|conflict|再提案/i);
    expect(readFileSync(filePath, "utf8")).toBe(externallyEdited);
  });

  it("compares raw bytes during apply drift checks", async () => {
    const proposal = await requestProposal();
    const invalidUtf8 = Buffer.from([0x82, 0xa0, 0x0a]);
    writeFileSync(filePath, invalidUtf8);

    const { res, body } = await postJson<{ error: string }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/変更|再提案/);
    expect(readFileSync(filePath)).toEqual(invalidUtf8);
  });

  it("refuses to edit non-UTF-8 files without overwriting their bytes", async () => {
    const shiftJisLikeBytes = Buffer.from([0x82, 0xa0, 0x82, 0xa2, 0x0a]);
    writeFileSync(filePath, shiftJisLikeBytes);

    const { res, body } = await postJson<{
      ok: false;
      error: string;
      proposalId?: string;
    }>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: "Change this file.",
    });

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.error).toBe(
      "このファイルはUTF-8ではないため安全に編集できません。"
    );
    expect(body.proposalId).toBeUndefined();
    expect(claudeMock.complete).not.toHaveBeenCalled();
    expect(readFileSync(filePath)).toEqual(shiftJisLikeBytes);
  });

  it("strips UTF-8 BOM from the diff and preserves it on apply", async () => {
    const bomContent = `\uFEFF${originalContent}`;
    writeFileSync(filePath, bomContent, "utf8");
    const proposal = await requestProposal(editedContent);

    expect(proposal.diff).not.toContain("\uFEFF");

    const applied = await postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: proposal.proposalId,
    });
    expect(applied.res.status).toBe(200);
    const raw = readFileSync(filePath);
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.toString("utf8")).toBe(`\uFEFF${editedContent}`);
  });

  it("logs a structured server error line without leaking the API key", async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { res, body } = await getJson<{ error: string }>(
        `/api/files/read?path=${encodeURIComponent(dirname(filePath))}`
      );

      expect(res.status).toBe(500);
      expect(body.error).toBeTruthy();
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      const logged = JSON.parse(line) as Record<string, unknown>;
      expect(logged).toMatchObject({
        level: "error",
        method: "GET",
        route: "/api/files/read",
      });
      expect(line).not.toContain("sk-ant-test-secret");
    } finally {
      spy.mockRestore();
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it("guards file read/write against traversal while allowing in-root paths", async () => {
    const outsideRead = await getJson<{ error: string }>(
      "/api/files/read?path=/etc/passwd"
    );
    expect(outsideRead.res.status).toBe(403);
    expect(outsideRead.body.error).toContain("範囲外");

    const outsideWrite = await postJson<{ error: string }>("/api/files/write", {
      path: join(root, "..", "uim-outside.txt"),
      content: "outside",
    });
    expect(outsideWrite.res.status).toBe(403);
    expect(outsideWrite.body.error).toContain("範囲外");

    const inRootFile = join(root, "src", "read-write.txt");
    const write = await postJson<{ ok: true }>("/api/files/write", {
      path: inRootFile,
      content: "inside",
    });
    expect(write.res.status).toBe(200);
    expect(write.body.ok).toBe(true);

    const read = await getJson<{ path: string; content: string }>(
      `/api/files/read?path=${encodeURIComponent(inRootFile)}`
    );
    expect(read.res.status).toBe(200);
    expect(read.body.content).toBe("inside");
  });

  it("does not store a proposal when Claude returns a truncated response", async () => {
    claudeMock.complete.mockRejectedValueOnce(
      new claudeMock.TruncatedError("truncated")
    );

    const proposal = await postJson<{
      ok: false;
      proposalId?: string;
      error?: string;
      summary?: string;
    }>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });

    expect(proposal.res.status).toBe(200);
    expect(proposal.body.ok).toBe(false);
    expect(proposal.body.proposalId).toBeUndefined();
    expect(proposal.body.error).toBe(
      "ファイルが大きすぎて完全な編集を生成できませんでした。ファイルを分割するか対象箇所を絞ってください。"
    );
    expect("summary" in proposal.body).toBe(false);
    expect(__stores.proposalStore.size).toBe(0);

    const apply = await postJson<{ error: string }>("/api/edit/apply", {
      proposalId: "00000000-0000-4000-8000-000000000000",
    });
    expect(apply.res.status).toBe(404);
    expect(apply.body.error).toMatch(/提案が見つかりません|not found/i);
  });

  it("returns an error field when no edit is generated", async () => {
    claudeMock.complete.mockResolvedValueOnce(originalContent);

    const proposal = await postJson<{
      ok: false;
      proposalId?: string;
      error?: string;
      summary?: string;
    }>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });

    expect(proposal.res.status).toBe(200);
    expect(proposal.body.ok).toBe(false);
    expect(proposal.body.proposalId).toBeUndefined();
    expect(proposal.body.error).toBe(
      "変更が生成されませんでした。指示をより具体的にしてください。"
    );
    expect("summary" in proposal.body).toBe(false);
    expect(__stores.proposalStore.size).toBe(0);
  });
});
