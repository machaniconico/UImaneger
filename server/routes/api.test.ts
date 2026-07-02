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
import { join } from "node:path";
import { api, __stores } from "./api.ts";
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
