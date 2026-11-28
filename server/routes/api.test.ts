// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import {
  api,
  __stores,
  clientErrorMessage,
  redactLocalPaths,
  isSafeGitRepoUrl,
  isTrustedRunCommandHost,
  isLoopbackBindHost,
  JSON_BODY_MAX_BYTES,
  atomicWrite,
  WriteTargetRejectedError,
} from "./api.ts";
import * as state from "../lib/state.ts";
import { openProject, stopProject } from "../lib/state.ts";
import { env } from "../lib/env.ts";
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
    streamComplete: vi.fn(),
    TruncatedError,
  };
});

const fsPromisesMock = vi.hoisted(() => ({
  actual: null as any,
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock("../lib/claude.ts", () => ({
  complete: claudeMock.complete,
  streamComplete: claudeMock.streamComplete,
  hasKey: () => true,
  stripCodeFence: (text: string) => {
    const m = text.match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)^```/m);
    if (!m) return text.trim();
    return m[1].replace(/\r?\n$/, "");
  },
  TruncatedError: claudeMock.TruncatedError,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<any>("node:fs/promises");
  fsPromisesMock.actual = actual;
  fsPromisesMock.readFile.mockImplementation((...args: any[]) =>
    actual.readFile(...args)
  );
  fsPromisesMock.writeFile.mockImplementation((...args: any[]) =>
    actual.writeFile(...args)
  );
  fsPromisesMock.mkdir.mockImplementation((...args: any[]) =>
    actual.mkdir(...args)
  );
  fsPromisesMock.rename.mockImplementation((...args: any[]) =>
    actual.rename(...args)
  );
  fsPromisesMock.unlink.mockImplementation((...args: any[]) =>
    actual.unlink(...args)
  );
  return {
    ...actual,
    readFile: fsPromisesMock.readFile,
    writeFile: fsPromisesMock.writeFile,
    mkdir: fsPromisesMock.mkdir,
    rename: fsPromisesMock.rename,
    unlink: fsPromisesMock.unlink,
  };
});

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

function toCrLf(content: string): string {
  return content.replace(/\n/g, "\r\n");
}

function countBareLf(content: string): number {
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n" && (i === 0 || content[i - 1] !== "\r")) {
      count++;
    }
  }
  return count;
}

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
  body: unknown,
  headers: Record<string, string> = {}
): Promise<JsonResponse<T>> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
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

async function postRaw<T = Record<string, unknown>>(
  path: string,
  body: string,
  contentType = "application/json"
): Promise<JsonResponse<T>> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  return {
    res,
    body: (await res.json()) as T,
  };
}

async function postSse(
  path: string,
  body: unknown
): Promise<{ res: Response; events: Array<Record<string, unknown>> }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = [...text.matchAll(/^data: ?(.*)$/gm)].map((match) =>
    JSON.parse(match[1])
  );
  return { res, events };
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

function resetFsPromiseMocks(): void {
  const actual = fsPromisesMock.actual;
  fsPromisesMock.readFile.mockReset();
  fsPromisesMock.writeFile.mockReset();
  fsPromisesMock.mkdir.mockReset();
  fsPromisesMock.rename.mockReset();
  fsPromisesMock.unlink.mockReset();
  fsPromisesMock.readFile.mockImplementation((...args: any[]) =>
    actual.readFile(...args)
  );
  fsPromisesMock.writeFile.mockImplementation((...args: any[]) =>
    actual.writeFile(...args)
  );
  fsPromisesMock.mkdir.mockImplementation((...args: any[]) =>
    actual.mkdir(...args)
  );
  fsPromisesMock.rename.mockImplementation((...args: any[]) =>
    actual.rename(...args)
  );
  fsPromisesMock.unlink.mockImplementation((...args: any[]) =>
    actual.unlink(...args)
  );
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

function runGit(args: string[], cwd = root): ReturnType<typeof spawnSync> {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

function initGitRepo(dir: string): boolean {
  const commands = [
    ["init"],
    ["config", "user.name", "test"],
    ["config", "user.email", "test@example.com"],
    ["add", "."],
    ["commit", "-m", "init"],
  ];
  return commands.every((args) => runGit(args, dir).status === 0);
}

beforeEach(async () => {
  resetFsPromiseMocks();
  claudeMock.complete.mockReset();
  claudeMock.streamComplete.mockReset();
  claudeMock.streamComplete.mockImplementation(
    (
      prompt: string,
      opts: unknown,
      onProgress?: (info: { chars: number; tail: string }) => void
    ) =>
      claudeMock.complete(prompt, opts, onProgress)
  );
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();

  // tmpdir が symlink の環境(macOS の /var → /private/var)や 8.3 短縮名の環境(Windows の RUNNER~1)でも、
  // atomicWrite が書く実体パス(realpathSync.native)とテストの filePath(fs モックの比較対象)が一致するよう、
  // root は製品と同じ .native で解決した実体パスで作る。JS 版の realpathSync は 8.3 名を展開しない。
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "uim-api-")));
  mkdirSync(join(root, "src"), { recursive: true });
  filePath = join(root, "src", "App.tsx");
  writeFileSync(filePath, originalContent, "utf8");

  await openProject(root, { command: "echo test-server-ready" });
});

afterEach(async () => {
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();
  resetFsPromiseMocks();
  await stopProject();
  rmSync(root, { recursive: true, force: true });
});

describe("project security helpers", () => {
  it("accepts only safe git clone URL formats", () => {
    expect(isSafeGitRepoUrl("https://github.com/example/repo.git")).toBe(true);
    expect(isSafeGitRepoUrl("ssh://git@github.com/example/repo.git")).toBe(true);
    expect(isSafeGitRepoUrl("git://github.com/example/repo.git")).toBe(false);
    expect(isSafeGitRepoUrl("git@github.com:example/repo.git")).toBe(true);

    expect(isSafeGitRepoUrl("ext::sh -c id")).toBe(false);
    expect(isSafeGitRepoUrl("file:///tmp/repo")).toBe(false);
    expect(isSafeGitRepoUrl("file::/tmp/repo")).toBe(false);
    expect(isSafeGitRepoUrl("-c protocol.ext.allow=always")).toBe(false);
    expect(isSafeGitRepoUrl("")).toBe(false);
  });

  it("accepts runCommand only from local Host values", () => {
    expect(isTrustedRunCommandHost("localhost")).toBe(true);
    expect(isTrustedRunCommandHost("localhost:5173")).toBe(true);
    expect(isTrustedRunCommandHost("127.0.0.1:8787")).toBe(true);
    expect(isTrustedRunCommandHost("[::1]:8787")).toBe(true);
    expect(isTrustedRunCommandHost("app.localhost:8787")).toBe(true);

    expect(isTrustedRunCommandHost(undefined)).toBe(false);
    expect(isTrustedRunCommandHost("")).toBe(false);
    expect(isTrustedRunCommandHost("example.com")).toBe(false);
    expect(isTrustedRunCommandHost("localhost.example.com")).toBe(false);
    expect(isTrustedRunCommandHost("[::1].example.com:8787")).toBe(false);
  });

  it("allows custom commands only when the server itself is loopback-bound", () => {
    expect(isLoopbackBindHost(undefined)).toBe(true);
    expect(isLoopbackBindHost("127.0.0.1")).toBe(true);
    expect(isLoopbackBindHost("::1")).toBe(true);
    expect(isLoopbackBindHost("0.0.0.0")).toBe(false);
    expect(isLoopbackBindHost("192.168.1.10")).toBe(false);
  });

  it("rejects a custom command on a non-loopback bind even with a local Host header", async () => {
    const previous = process.env.UIM_HOST;
    process.env.UIM_HOST = "0.0.0.0";
    try {
      const result = await postJson<{ error: string }>(
        "/api/project/open",
        { path: root, runCommand: "npm run dev" },
        { host: "localhost:5174" }
      );
      expect(result.res.status).toBe(403);
      expect(result.body.error).toContain("ローカル");
    } finally {
      if (previous === undefined) delete process.env.UIM_HOST;
      else process.env.UIM_HOST = previous;
    }
  });

  it.each([
    ["number", 42],
    ["object", { command: "npm run dev" }],
    ["empty", "   "],
    ["multiline", "npm run dev\necho unsafe"],
    ["oversized", "x".repeat(2_001)],
  ])("rejects an invalid %s runCommand", async (_label, runCommand) => {
    const result = await postJson<{ error: string }>("/api/project/open", {
      path: root,
      runCommand,
    });

    expect(result.res.status).toBe(400);
    expect(result.body.error).toContain("runCommand");
  });

  it("rejects non-string and non-directory project paths", async () => {
    const invalidType = await postJson<{ error: string }>("/api/project/open", {
      path: 42,
    });
    expect(invalidType.res.status).toBe(400);
    expect(invalidType.body.error).toContain("path");

    const fileInsteadOfDirectory = await postJson<{ error: string }>(
      "/api/project/open",
      { path: filePath }
    );
    expect(fileInsteadOfDirectory.res.status).toBe(400);
    expect(fileInsteadOfDirectory.body.error).toContain("ディレクトリ");
  });

  it("rejects unsafe clone URLs before invoking git", async () => {
    const result = await postJson<{ error: string }>("/api/project/clone", {
      repo: "ext::sh -c id",
    });

    expect(result.res.status).toBe(400);
    expect(result.body.error).toBe("対応していないリポジトリURL形式です");
  });

  it("rejects runCommand when Host is not local", async () => {
    const result = await postJson<{ error: string }>(
      "/api/project/open",
      {
        path: root,
        runCommand: "sh -c id",
      },
      { host: "example.com" }
    );

    expect(result.res.status).toBe(403);
    expect(result.body.error).toBe(
      "runCommand の実行にはローカルからのアクセスが必要です"
    );
  });

  it("does not reveal the absolute workspaces path when the clone destination is not a git repository", async () => {
    const workspaces = mkdtempSync(join(tmpdir(), "uim-ws-"));
    const previous = env.workspacesDir;
    const repo = "https://github.com/example/repo.git";
    const fingerprint = createHash("sha256").update(repo).digest("hex").slice(0, 10);
    mkdirSync(join(workspaces, `repo-${fingerprint}`));
    (env as { workspacesDir: string }).workspacesDir = workspaces;
    try {
      const result = await postJson<{ error: string }>("/api/project/clone", { repo });
      expect(result.res.status).toBeGreaterThanOrEqual(400);
      expect(result.body.error).toContain("Gitリポジトリではありません");
      expect(result.body.error).toContain(`repo-${fingerprint}`);
      expect(result.body.error).not.toContain(workspaces);
    } finally {
      (env as { workspacesDir: string }).workspacesDir = previous;
      rmSync(workspaces, { recursive: true, force: true });
    }
  });

  it("does not reveal the absolute workspaces path when git clone itself fails", () => {
    const workspaces = mkdtempSync(join(tmpdir(), "uim-ws-"));
    const previous = env.workspacesDir;
    (env as { workspacesDir: string }).workspacesDir = workspaces;
    try {
      // execFile の失敗は "Command failed: git clone ... <絶対パス>" を message に含む
      const message = clientErrorMessage(
        new Error(`Command failed: git clone --depth 1 -- https://example.com/r.git ${join(workspaces, "r-0123456789")}\nfatal: unable to access`)
      );
      expect(message).not.toContain(workspaces);
      // 区切りは OS によらず "/" に揃える
      expect(message).toContain("workspaces/r-0123456789");
    } finally {
      (env as { workspacesDir: string }).workspacesDir = previous;
      rmSync(workspaces, { recursive: true, force: true });
    }
  });

  it("redacts local paths only at path boundaries, preferring the most specific entry", () => {
    const posix = (message: string, root: string | null, workspaces: string) =>
      redactLocalPaths(message, [{ path: root, label: "." }, { path: workspaces, label: "workspaces" }], "linux");
    // workspaces がルートの子: より具体的な workspaces で置換する
    expect(posix("fail /srv/app/cache/r and /srv/app/src/a.ts", "/srv/app", "/srv/app/cache")).toBe(
      "fail workspaces/r and src/a.ts"
    );
    // workspaces がルートの親: ルートはルートで、兄弟は workspaces で置換する
    expect(posix("x /srv/app/r y /srv/other/r", "/srv/app", "/srv")).toBe("x r y workspaces/other/r");
    // ファイルシステムのルートや部分一致・URL は置換しない
    expect(posix("see https://host/r", null, "/")).toBe("see https://host/r");
    expect(posix("in /www/r", null, "/w")).toBe("in /www/r");
    expect(posix("open https://w/r", null, "/w")).toBe("open https://w/r");
    expect(posix("at /w", null, "/w")).toBe("at workspaces");
    // Windows: 大文字小文字と区切りの違いを吸収する
    const win = (message: string) =>
      redactLocalPaths(message, [{ path: null, label: "." }, { path: "C:\\WS", label: "workspaces" }], "win32");
    expect(win("git clone c:\\WS\\r failed")).toBe("git clone workspaces/r failed");
    expect(win("git clone C:/ws/r failed")).toBe("git clone workspaces/r failed");
    expect(win("drive C:\\ only")).toBe("drive C:\\ only");
    // Linux は大文字小文字を区別する
    expect(posix("/SRV/app/x", "/srv/app", "/ws")).toBe("/SRV/app/x");
  });

  it("rejects clone runCommand when Host is not local", async () => {
    const result = await postJson<{ error: string }>(
      "/api/project/clone",
      {
        repo: "https://github.com/example/repo.git",
        runCommand: "sh -c id",
      },
      { host: "example.com" }
    );

    expect(result.res.status).toBe(403);
    expect(result.body.error).toBe(
      "runCommand の実行にはローカルからのアクセスが必要です"
    );
  });

  it("returns a JSON 400 for malformed JSON request bodies", async () => {
    const result = await postRaw<{ error: string }>(
      "/api/edit/candidate",
      "{not-json"
    );

    expect(result.res.status).toBe(400);
    expect(result.body.error).toBe("JSON body が不正です");
  });

  it("returns a JSON 400 for non-object JSON request bodies", async () => {
    const result = await postRaw<{ error: string }>(
      "/api/edit/candidate",
      "null"
    );

    expect(result.res.status).toBe(400);
    expect(result.body.error).toBe("JSON body はオブジェクトである必要があります");
  });

  it("returns a JSON 413 for oversized JSON request bodies", async () => {
    const result = await postRaw<{ error: string }>(
      "/api/edit/candidate",
      `{"content":"${"x".repeat(JSON_BODY_MAX_BYTES)}"}`
    );

    expect(result.res.status).toBe(413);
    expect(result.body.error).toContain("JSON body が大きすぎます");
  });
});

describe("edit proposal API", () => {
  it("rejects non-string edit instructions", async () => {
    const result = await postJson<{ error: string }>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: { text: "change it" },
    });
    expect(result.res.status).toBe(400);
    expect(result.body.error).toContain("文字列");
    expect(claudeMock.complete).not.toHaveBeenCalled();
  });

  it("passes the chosen edit model through candidate selection", async () => {
    claudeMock.complete.mockResolvedValueOnce(editedContent);
    const result = await postJson<{ ok: boolean }>("/api/edit/candidate", {
      file: filePath,
      line: 8,
      descriptor: descriptorFor(filePath),
      instruction: "Change it",
      model: "claude-haiku-4-5",
    });
    expect(result.res.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(claudeMock.streamComplete).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: "claude-haiku-4-5" }),
      undefined
    );

    const rejected = await postJson<{ error: string }>("/api/edit/candidate", {
      file: filePath,
      instruction: "Change it",
      model: "gpt-unknown",
    });
    expect(rejected.res.status).toBe(400);
    expect(rejected.body.error).toBe("許可されていないモデルです");
  });

  it("rejects invalid candidate line numbers", async () => {
    const result = await postJson<{ error: string }>("/api/edit/candidate", {
      file: filePath,
      line: 0,
      descriptor: descriptorFor(filePath),
      instruction: "Change it",
    });
    expect(result.res.status).toBe(400);
    expect(result.body.error).toContain("line");
    expect(claudeMock.complete).not.toHaveBeenCalled();
  });

  it("requires explicit candidate selection for a non-authoring text hit", async () => {
    const messagesFile = join(root, "src", "messages.json");
    writeFileSync(messagesFile, '{ "cta": "LocaleOnlyCheckoutLabel" }', "utf8");

    const { res, body } = await postJson<{
      ok: false;
      confidence: string;
      candidates: { file: string }[];
    }>("/api/edit", {
      descriptor: {
        tag: "button",
        classes: [],
        attrs: {},
        textSnippet: "LocaleOnlyCheckoutLabel",
        domPath: "button",
      },
      instruction: "Make it red.",
    });

    expect(res.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.confidence).toBe("low");
    expect(body.candidates[0]?.file).toBe(messagesFile);
    expect(claudeMock.complete).not.toHaveBeenCalled();
  });

  it("returns the available edit models and server default", async () => {
    const originalEditModel = env.editModel;
    env.editModel = "claude-opus-4-8";
    try {
      const { res, body } = await getJson<{
        models: Array<{ id: string; label: string; note: string }>;
        default: string;
      }>("/api/models");

      expect(res.status).toBe(200);
      expect(body).toEqual({
        models: [
          { id: "claude-opus-4-8", label: "Opus 4.8", note: "高品質(既定)" },
          { id: "claude-sonnet-5", label: "Sonnet 5", note: "バランス・高速" },
          { id: "claude-haiku-4-5", label: "Haiku 4.5", note: "最速・最安" },
        ],
        default: "claude-opus-4-8",
      });
    } finally {
      env.editModel = originalEditModel;
    }
  });

  it("includes and accepts a custom UIM_EDIT_MODEL", async () => {
    const originalEditModel = env.editModel;
    env.editModel = "claude-custom-local";
    try {
      const models = await getJson<{
        models: Array<{ id: string; label: string; note: string }>;
        default: string;
      }>("/api/models");
      expect(models.body.default).toBe("claude-custom-local");
      expect(models.body.models.at(-1)).toEqual({
        id: "claude-custom-local",
        label: "claude-custom-local",
        note: "UIM_EDIT_MODEL",
      });

      claudeMock.complete.mockResolvedValueOnce(editedContent);
      const edit = await postJson<ProposalBody>("/api/edit", {
        descriptor: descriptorFor(filePath),
        instruction: "Change the button label.",
        model: "claude-custom-local",
      });
      expect(edit.res.status).toBe(200);
      expect(claudeMock.streamComplete).toHaveBeenCalledWith(
        expect.any(String),
        {
          maxTokens: 64000,
          model: "claude-custom-local",
          adaptive: false,
        },
        undefined
      );
    } finally {
      env.editModel = originalEditModel;
    }
  });

  it("rejects an unknown edit model", async () => {
    const { res, body } = await postJson<{ error: string }>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
      model: "claude-unknown",
    });

    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "許可されていないモデルです" });
    expect(claudeMock.streamComplete).not.toHaveBeenCalled();
  });

  it.each([
    ["claude-haiku-4-5", false],
    ["claude-sonnet-5", true],
  ])("forwards model %s with adaptive=%s", async (model, adaptive) => {
    claudeMock.complete.mockResolvedValueOnce(editedContent);

    const { res } = await postJson<ProposalBody>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
      model,
    });

    expect(res.status).toBe(200);
    expect(claudeMock.streamComplete).toHaveBeenCalledWith(
      expect.any(String),
      { maxTokens: 64000, model, adaptive },
      undefined
    );
  });

  it("streams resolving, generating, progress, and a successful result", async () => {
    claudeMock.complete.mockImplementationOnce(
      async (
        _prompt: string,
        _opts: unknown,
        onProgress?: (info: { chars: number; tail: string }) => void
      ) => {
        onProgress?.({ chars: 42, tail: "generated tail" });
        return editedContent;
      }
    );

    const { res, events } = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });

    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(events.map((event) => event.type)).toEqual([
      "stage",
      "stage",
      "progress",
      "result",
    ]);
    expect(events[0]).toEqual({ type: "stage", stage: "resolving" });
    expect(events[1]).toEqual({
      type: "stage",
      stage: "generating",
      file: "src/App.tsx",
    });
    expect(events[2]).toEqual({
      type: "progress",
      chars: 42,
      tail: "generated tail",
    });
    expect(events[3]).toMatchObject({
      type: "result",
      ok: true,
      relFile: "src/App.tsx",
    });
    expect(typeof events[3].proposalId).toBe("string");
  });

  it("does not store completed generations after an A-B-A project switch", async () => {
    const bothGenerationsStarted = deferred();
    const releaseGenerations = deferred();
    let started = 0;
    claudeMock.complete.mockImplementation(async () => {
      started++;
      if (started === 2) bothGenerationsStarted.resolve();
      await releaseGenerations.promise;
      return editedContent;
    });

    const jsonGeneration = postJson<{ error: string }>("/api/edit", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });
    const streamGeneration = postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });
    await bothGenerationsStarted.promise;

    const nextRoot = mkdtempSync(join(tmpdir(), "uim-api-generation-aba-"));
    mkdirSync(join(nextRoot, "src"), { recursive: true });
    writeFileSync(join(nextRoot, "src", "App.tsx"), originalContent, "utf8");
    await openProject(nextRoot, { command: "echo test-server-ready" });
    await getJson("/api/status");
    await openProject(root, { command: "echo test-server-ready" });
    await getJson("/api/status");

    releaseGenerations.resolve();
    const [jsonResult, streamResult] = await Promise.all([
      jsonGeneration,
      streamGeneration,
    ]);

    expect(jsonResult.res.status).toBe(409);
    expect(jsonResult.body.error).toBe(
      "プロジェクトが切り替わったため中断しました"
    );
    expect(streamResult.events.at(-1)).toMatchObject({
      type: "result",
      ok: false,
      error: "プロジェクトが切り替わったため中断しました",
    });
    expect(__stores.proposalStore.size).toBe(0);
    rmSync(nextRoot, { recursive: true, force: true });
  });

  it("refines a previous pending proposal while keeping the disk file as the diff baseline", async () => {
    const firstProposed = editedContent.replace(
      "Saved successfully",
      "First pending version"
    );
    const refinedProposed = editedContent.replace(
      "Saved successfully",
      "Refined pending version"
    );
    claudeMock.complete.mockResolvedValueOnce(firstProposed);
    const first = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });
    const firstResult = first.events.at(-1)!;

    claudeMock.complete.mockResolvedValueOnce(refinedProposed);
    const second = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Make it more prominent.",
      previousProposalId: firstResult.proposalId,
    });
    const secondResult = second.events.at(-1)!;
    const secondPrompt = String(claudeMock.complete.mock.calls[1][0]);

    expect(secondPrompt).toContain("First pending version");
    expect(secondPrompt).toContain(
      "現在の作業版（ユーザーの前回の指示を反映済み）"
    );
    expect(secondResult).toMatchObject({ type: "result", ok: true });
    expect(String(secondResult.diff)).toContain("Save now");
    expect(String(secondResult.diff)).toContain("Refined pending version");
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);

    const applied = await postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: secondResult.proposalId,
    });
    expect(applied.res.status).toBe(200);
    expect(readFileSync(filePath, "utf8")).toBe(refinedProposed);
  });

  it("falls back to the current disk content when the refinement baseline bytes changed", async () => {
    const firstProposed = editedContent.replace(
      "Saved successfully",
      "First pending version"
    );
    claudeMock.complete.mockResolvedValueOnce(firstProposed);
    const first = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });
    const firstResult = first.events.at(-1)!;
    const interveningContent = originalContent.replace(
      "const label = \"Save now\";",
      "const label = \"Changed on disk\";"
    );
    writeFileSync(filePath, interveningContent, "utf8");
    claudeMock.complete.mockResolvedValueOnce(
      interveningContent.replace("Changed on disk", "Fresh proposal")
    );

    const second = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Make it more prominent.",
      previousProposalId: firstResult.proposalId,
    });
    const secondPrompt = String(claudeMock.complete.mock.calls[1][0]);

    expect(secondPrompt).toContain("Changed on disk");
    expect(secondPrompt).not.toContain("First pending version");
    expect(secondPrompt).not.toContain(
      "現在の作業版（ユーザーの前回の指示を反映済み）"
    );
    expect(second.events.at(-1)).toMatchObject({ type: "result", ok: true });
  });

  it("returns an explicit error when a supplied refinement proposal is missing", async () => {
    const { events } = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "Make it more prominent.",
      previousProposalId: "missing-proposal",
    });

    expect(events.at(-1)).toMatchObject({
      type: "result",
      ok: false,
      error:
        "追い込み元の提案が見つかりませんでした（期限切れの可能性）。もう一度通常の指示からやり直してください。",
    });
    expect(claudeMock.streamComplete).not.toHaveBeenCalled();
  });

  it("includes ok:false in validation failure stream results", async () => {
    const { events } = await postSse("/api/edit/stream", {
      descriptor: descriptorFor(filePath),
      instruction: "",
    });

    expect(events.at(-1)).toMatchObject({
      type: "result",
      ok: false,
      error: "指示が空です",
    });
  });

  it("ends the stream with a result when source resolution finds no file", async () => {
    const { events } = await postSse("/api/edit/stream", {
      descriptor: {
        tag: "definitely-absent-tag",
        classes: ["uim-no-match-unique"],
        attrs: {},
        domPath: "",
      },
      instruction: "Change this element.",
    });

    expect(events.map((event) => event.type)).toEqual(["stage", "result"]);
    expect(events.at(-1)).toMatchObject({
      type: "result",
      ok: false,
      confidence: "low",
      candidates: [],
    });
    expect(claudeMock.streamComplete).not.toHaveBeenCalled();
  });

  it("ends the stream with the server error result shape when generation throws", async () => {
    claudeMock.complete.mockRejectedValueOnce(new Error("stream failed"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { events } = await postSse("/api/edit/stream", {
        descriptor: descriptorFor(filePath),
        instruction: "Change the button label.",
      });

      expect(events.at(-1)).toEqual({
        type: "result",
        ok: false,
        error: "stream failed",
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

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

  it("creates a proposal from an explicit candidate file", async () => {
    claudeMock.complete.mockResolvedValueOnce(editedContent);

    const { res, body } = await postJson<ProposalBody>("/api/edit/candidate", {
      file: filePath,
      line: 8,
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      file: filePath,
      relFile: "src/App.tsx",
      line: 8,
      confidence: "medium",
    });
    expect(body.diff).toContain("Saved successfully");
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("keeps CRLF files CRLF when model output is LF-normalized", async () => {
    const originalCrLf = toCrLf(originalContent);
    const editedCrLf = toCrLf(editedContent);
    writeFileSync(filePath, originalCrLf, "utf8");
    claudeMock.complete.mockResolvedValueOnce(editedContent);

    const { res, body } = await postJson<ProposalBody>("/api/edit/candidate", {
      file: filePath,
      line: 4,
      descriptor: descriptorFor(filePath),
      instruction: "Change the button label.",
    });

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const diffLines = body.diff
      .split("\n")
      .map((line) => line.replace(/\r$/, ""));
    const removals = diffLines.filter(
      (line) => line.startsWith("-") && !line.startsWith("---")
    );
    const additions = diffLines.filter(
      (line) => line.startsWith("+") && !line.startsWith("+++")
    );
    expect(removals).toEqual(['-  const label = "Save now";']);
    expect(additions).toEqual(['+  const label = "Saved successfully";']);

    const applied = await postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: body.proposalId,
    });
    expect(applied.res.status).toBe(200);
    const appliedContent = readFileSync(filePath, "utf8");
    expect(appliedContent).toBe(editedCrLf);
    expect(countBareLf(appliedContent)).toBe(0);
  });

  it("allows trailing newline-only edits but rejects identical output", async () => {
    claudeMock.complete.mockResolvedValueOnce(originalContent);

    const identical = await postJson<{
      ok: false;
      proposalId?: string;
      error?: string;
    }>("/api/edit/candidate", {
      file: filePath,
      descriptor: descriptorFor(filePath),
      instruction: "Keep the file unchanged.",
    });

    expect(identical.res.status).toBe(200);
    expect(identical.body.ok).toBe(false);
    expect(identical.body.proposalId).toBeUndefined();
    expect(identical.body.error).toBe(
      "変更が生成されませんでした。指示をより具体的にしてください。"
    );
    expect(__stores.proposalStore.size).toBe(0);

    claudeMock.complete.mockResolvedValueOnce(
      `\`\`\`tsx\n${originalContent}\n\n\`\`\``
    );
    const trailingNewline = await postJson<ProposalBody>(
      "/api/edit/candidate",
      {
        file: filePath,
        descriptor: descriptorFor(filePath),
        instruction: "Add a final newline.",
      }
    );

    expect(trailingNewline.res.status).toBe(200);
    expect(trailingNewline.body.ok).toBe(true);
    expect(trailingNewline.body.diff).toContain("@@");

    const applied = await postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: trailingNewline.body.proposalId,
    });
    expect(applied.res.status).toBe(200);
    expect(readFileSync(filePath, "utf8")).toBe(`${originalContent}\n`);
  });

  it("rejects candidate files outside the project root", async () => {
    const { res, body } = await postJson<{ error: string }>(
      "/api/edit/candidate",
      {
        file: join(root, "..", "outside.tsx"),
        descriptor: descriptorFor(filePath),
        instruction: "Change the button label.",
      }
    );

    expect(res.status).toBe(403);
    expect(body.error).toContain("範囲外");
    expect(claudeMock.complete).not.toHaveBeenCalled();
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

  it("remaps before-preview file URLs back to the real project root", async () => {
    const beforeDir = mkdtempSync(join(tmpdir(), "uim-before-url-route-"));
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
        descriptor: descriptorFor(pathToFileURL(beforeFile).href),
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

  it("refuses to apply while the same proposal is already in flight", async () => {
    const proposal = await requestProposal();
    __stores.inFlight.add(proposal.proposalId);

    const { res, body } = await postJson<{ error: string }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );

    expect(res.status).toBe(409);
    expect(body.error).toBe("この提案は現在処理中です。");
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);
  });

  it("serializes concurrent apply operations for proposals targeting the same file", async () => {
    const firstContent = originalContent.replace(
      'const label = "Save now";',
      'const label = "First edit";'
    );
    const secondContent = originalContent.replace(
      'const label = "Save now";',
      'const label = "Second edit";'
    );
    const firstProposal = await requestProposal(firstContent);
    const secondProposal = await requestProposal(secondContent);

    const actualReadFile = fsPromisesMock.actual.readFile;
    const actualWriteFile = fsPromisesMock.actual.writeFile;
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    let blockedWrite = false;
    let targetReads = 0;
    fsPromisesMock.readFile.mockImplementation(async (...args: any[]) => {
      if (String(args[0]) === filePath) targetReads++;
      return actualReadFile(...args);
    });
    fsPromisesMock.writeFile.mockImplementation(async (...args: any[]) => {
      if (
        !blockedWrite &&
        String(args[0]).startsWith(`${filePath}.tmp-`)
      ) {
        blockedWrite = true;
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      return actualWriteFile(...args);
    });

    const firstApply = postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: firstProposal.proposalId,
    });
    await firstWriteStarted.promise;
    expect(targetReads).toBe(1);

    const secondApply = postJson<{ error: string }>("/api/edit/apply", {
      proposalId: secondProposal.proposalId,
    });
    await delay(25);
    expect(targetReads).toBe(1);

    releaseFirstWrite.resolve();
    const [firstResult, secondResult] = await Promise.all([
      firstApply,
      secondApply,
    ]);

    expect(firstResult.res.status).toBe(200);
    expect(secondResult.res.status).toBe(409);
    expect(secondResult.body.error).toBe(
      "ファイルが変更されています。再提案してください。"
    );
    expect(readFileSync(filePath, "utf8")).toBe(firstContent);
    expect(__stores.undoStack).toHaveLength(1);
    expect(__stores.proposalStore.has(secondProposal.proposalId)).toBe(true);
  });

  it("serializes concurrent apply operations globally across different files", async () => {
    const otherFilePath = join(root, "src", "Other.tsx");
    writeFileSync(otherFilePath, originalContent, "utf8");
    const firstContent = originalContent.replace(
      'const label = "Save now";',
      'const label = "First file edit";'
    );
    const secondContent = originalContent.replace(
      'const label = "Save now";',
      'const label = "Second file edit";'
    );
    const firstProposal = await requestProposal(firstContent);
    claudeMock.complete.mockResolvedValueOnce(secondContent);
    const secondProposal = await postJson<ProposalBody>(
      "/api/edit/candidate",
      {
        file: otherFilePath,
        descriptor: descriptorFor(otherFilePath),
        instruction: "Change the button label.",
      }
    );
    expect(secondProposal.res.status).toBe(200);

    const actualWriteFile = fsPromisesMock.actual.writeFile;
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    let blockedWrite = false;
    fsPromisesMock.writeFile.mockImplementation(async (...args: any[]) => {
      if (
        !blockedWrite &&
        String(args[0]).startsWith(`${filePath}.tmp-`)
      ) {
        blockedWrite = true;
        firstWriteStarted.resolve();
        await releaseFirstWrite.promise;
      }
      return actualWriteFile(...args);
    });

    const firstApply = postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: firstProposal.proposalId,
    });
    await firstWriteStarted.promise;

    const secondApply = postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: secondProposal.body.proposalId,
    });
    const completedBeforeRelease = await Promise.race([
      secondApply.then(() => true),
      delay(50).then(() => false),
    ]);
    releaseFirstWrite.resolve();
    const [firstResult, secondResult] = await Promise.all([
      firstApply,
      secondApply,
    ]);

    expect(completedBeforeRelease).toBe(false);
    expect(firstResult.res.status).toBe(200);
    expect(secondResult.res.status).toBe(200);
    expect(readFileSync(filePath, "utf8")).toBe(firstContent);
    expect(readFileSync(otherFilePath, "utf8")).toBe(secondContent);
  });

  it("serializes undo then apply without resurrecting redo history", async () => {
    const otherFilePath = join(root, "src", "Other.tsx");
    writeFileSync(otherFilePath, originalContent, "utf8");
    const firstProposal = await requestProposal();
    claudeMock.complete.mockResolvedValueOnce(
      originalContent.replace("Save now", "Other saved")
    );
    const secondProposal = await postJson<ProposalBody>(
      "/api/edit/candidate",
      {
        file: otherFilePath,
        descriptor: descriptorFor(otherFilePath),
        instruction: "Change the other button label.",
      }
    );
    await postJson("/api/edit/apply", {
      proposalId: firstProposal.proposalId,
    });

    const actualWriteFile = fsPromisesMock.actual.writeFile;
    const undoWriteStarted = deferred();
    const releaseUndoWrite = deferred();
    let blockedWrite = false;
    fsPromisesMock.writeFile.mockImplementation(async (...args: any[]) => {
      if (!blockedWrite && String(args[0]).startsWith(`${filePath}.tmp-`)) {
        blockedWrite = true;
        undoWriteStarted.resolve();
        await releaseUndoWrite.promise;
      }
      return actualWriteFile(...args);
    });

    const undo = postJson<{ ok: true }>("/api/edit/undo", {});
    await undoWriteStarted.promise;
    const apply = postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: secondProposal.body.proposalId,
    });
    const applyCompletedEarly = await Promise.race([
      apply.then(() => true),
      delay(50).then(() => false),
    ]);

    expect(applyCompletedEarly).toBe(false);
    releaseUndoWrite.resolve();
    const [undoResult, applyResult] = await Promise.all([undo, apply]);

    expect(undoResult.res.status).toBe(200);
    expect(applyResult.res.status).toBe(200);
    expect(__stores.redoStack).toHaveLength(0);
    expect(__stores.undoStack).toHaveLength(1);
    expect(__stores.historyLog.map((entry) => entry.kind)).toEqual([
      "apply",
      "undo",
      "apply",
    ]);
  });

  it("aborts apply when the project changes after reading the file", async () => {
    const proposal = await requestProposal();
    const actualReadFile = fsPromisesMock.actual.readFile;
    const readStarted = deferred();
    const releaseRead = deferred();
    let delayed = false;
    fsPromisesMock.readFile.mockImplementation(async (...args: any[]) => {
      if (!delayed && String(args[0]) === filePath) {
        delayed = true;
        const result = await actualReadFile(...args);
        readStarted.resolve();
        await releaseRead.promise;
        return result;
      }
      return actualReadFile(...args);
    });

    const oldRoot = root;
    const oldFilePath = filePath;
    const applyPromise = postJson<{ error: string }>("/api/edit/apply", {
      proposalId: proposal.proposalId,
    });
    await readStarted.promise;

    const nextRoot = mkdtempSync(join(tmpdir(), "uim-api-race-"));
    mkdirSync(join(nextRoot, "src"), { recursive: true });
    writeFileSync(join(nextRoot, "src", "App.tsx"), originalContent, "utf8");
    await openProject(nextRoot, { command: "echo test-server-ready" });
    root = nextRoot;
    filePath = join(nextRoot, "src", "App.tsx");

    releaseRead.resolve();
    const result = await applyPromise;

    expect(result.res.status).toBe(409);
    expect(result.body.error).toBe(
      "プロジェクトが切り替わったため中断しました"
    );
    expect(__stores.undoStack).toHaveLength(0);
    expect(__stores.redoStack).toHaveLength(0);
    expect(__stores.historyLog).toHaveLength(0);
    expect(readFileSync(oldFilePath, "utf8")).toBe(originalContent);
    rmSync(oldRoot, { recursive: true, force: true });
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

  it("round-trips apply, undo, and redo while reporting stack depths", async () => {
    const proposal = await requestProposal();

    const applied = await postJson<{ ok: true; undoDepth: number }>(
      "/api/edit/apply",
      { proposalId: proposal.proposalId }
    );
    expect(applied.res.status).toBe(200);
    expect(applied.body.undoDepth).toBe(1);
    expect(readFileSync(filePath, "utf8")).toBe(editedContent);

    const statusAfterApply = await getJson<{
      undoDepth: number;
      redoDepth: number;
    }>("/api/status");
    expect(statusAfterApply.body).toMatchObject({
      undoDepth: 1,
      redoDepth: 0,
    });

    const undone = await postJson<{
      ok: true;
      undoDepth: number;
      redoDepth: number;
    }>("/api/edit/undo", {});
    expect(undone.res.status).toBe(200);
    expect(undone.body).toMatchObject({ undoDepth: 0, redoDepth: 1 });
    expect(readFileSync(filePath, "utf8")).toBe(originalContent);

    const redone = await postJson<{
      ok: true;
      undoDepth: number;
      redoDepth: number;
    }>("/api/edit/redo", {});
    expect(redone.res.status).toBe(200);
    expect(redone.body).toMatchObject({ undoDepth: 1, redoDepth: 0 });
    expect(readFileSync(filePath, "utf8")).toBe(editedContent);
  });

  it("keeps the redo entry when the file changed after undo", async () => {
    const proposal = await requestProposal();
    await postJson("/api/edit/apply", { proposalId: proposal.proposalId });
    await postJson("/api/edit/undo", {});
    const drifted = originalContent.replace("Save now", "Changed later");
    writeFileSync(filePath, drifted, "utf8");

    const redone = await postJson<{ error: string }>("/api/edit/redo", {});

    expect(redone.res.status).toBe(409);
    expect(redone.body.error).toMatch(/変更|やり直/);
    expect(__stores.redoStack).toHaveLength(1);
    expect(readFileSync(filePath, "utf8")).toBe(drifted);
  });

  it("clears the redo stack after a new apply", async () => {
    const firstProposal = await requestProposal();
    await postJson("/api/edit/apply", {
      proposalId: firstProposal.proposalId,
    });
    await postJson("/api/edit/undo", {});
    expect(__stores.redoStack).toHaveLength(1);

    const secondProposal = await requestProposal();
    const applied = await postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: secondProposal.proposalId,
    });

    expect(applied.res.status).toBe(200);
    expect(__stores.redoStack).toHaveLength(0);
    expect(readFileSync(filePath, "utf8")).toBe(editedContent);
  });

  it("returns apply, undo, and redo history in newest-first order", async () => {
    const proposal = await requestProposal();
    await postJson("/api/edit/apply", { proposalId: proposal.proposalId });
    await postJson("/api/edit/undo", {});
    await postJson("/api/edit/redo", {});

    const history = await getJson<{
      history: Array<{ kind: string; relFile: string }>;
    }>("/api/edit/history");

    expect(history.res.status).toBe(200);
    expect(history.body.history).toHaveLength(3);
    expect(history.body.history.map(({ kind, relFile }) => ({ kind, relFile })))
      .toEqual([
        { kind: "redo", relFile: "src/App.tsx" },
        { kind: "undo", relFile: "src/App.tsx" },
        { kind: "apply", relFile: "src/App.tsx" },
      ]);
  });

  it("refuses to undo while the same proposal is already in flight", async () => {
    const proposal = await requestProposal();
    await postJson("/api/edit/apply", { proposalId: proposal.proposalId });
    __stores.inFlight.add(proposal.proposalId);

    const { res, body } = await postJson<{ error: string }>(
      "/api/edit/undo",
      {}
    );

    expect(res.status).toBe(409);
    expect(body.error).toBe("この提案は現在処理中です。");
    expect(__stores.undoStack).toHaveLength(1);
    expect(__stores.redoStack).toHaveLength(0);
    expect(__stores.historyLog).toHaveLength(1);
    expect(readFileSync(filePath, "utf8")).toBe(editedContent);
  });

  it("aborts undo when the project changes after reading the file", async () => {
    const proposal = await requestProposal();
    await postJson("/api/edit/apply", { proposalId: proposal.proposalId });
    const actualReadFile = fsPromisesMock.actual.readFile;
    const readStarted = deferred();
    const releaseRead = deferred();
    let delayed = false;
    fsPromisesMock.readFile.mockImplementation(async (...args: any[]) => {
      if (!delayed && String(args[0]) === filePath) {
        delayed = true;
        const result = await actualReadFile(...args);
        readStarted.resolve();
        await releaseRead.promise;
        return result;
      }
      return actualReadFile(...args);
    });

    const oldRoot = root;
    const oldFilePath = filePath;
    const undoPromise = postJson<{ error: string }>("/api/edit/undo", {});
    await readStarted.promise;

    const nextRoot = mkdtempSync(join(tmpdir(), "uim-api-undo-race-"));
    mkdirSync(join(nextRoot, "src"), { recursive: true });
    writeFileSync(join(nextRoot, "src", "App.tsx"), originalContent, "utf8");
    await openProject(nextRoot, { command: "echo test-server-ready" });
    root = nextRoot;
    filePath = join(nextRoot, "src", "App.tsx");

    releaseRead.resolve();
    const result = await undoPromise;

    expect(result.res.status).toBe(409);
    expect(result.body.error).toBe(
      "プロジェクトが切り替わったため中断しました"
    );
    expect(__stores.undoStack).toHaveLength(0);
    expect(__stores.redoStack).toHaveLength(0);
    expect(__stores.historyLog).toHaveLength(0);
    expect(readFileSync(oldFilePath, "utf8")).toBe(editedContent);
    rmSync(oldRoot, { recursive: true, force: true });
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
    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- 伏せ字化の検証用ダミー値
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-secret";
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // ディレクトリを候補にすると読み込みで EISDIR になり、500 とエラーログ 1 行になる。
      const { res, body } = await postJson<{ error: string }>("/api/edit/candidate", {
        file: dirname(filePath),
        instruction: "Change the button label.",
      });

      expect(res.status).toBe(500);
      expect(body.error).toBeTruthy();
      expect(spy).toHaveBeenCalledTimes(1);
      const line = String(spy.mock.calls[0][0]);
      const logged = JSON.parse(line) as Record<string, unknown>;
      expect(logged).toMatchObject({
        level: "error",
        method: "POST",
        route: "/api/edit/candidate",
      });
      expect(line).not.toContain("sk-ant-test-secret");
      expect(claudeMock.complete).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
    }
  });

  it("guards candidate/apply against traversal while allowing in-root paths", async () => {
    const outsideAbs = await postJson<{ error: string }>("/api/edit/candidate", {
      file: "/etc/passwd",
      instruction: "Change it.",
    });
    expect(outsideAbs.res.status).toBe(403);
    expect(outsideAbs.body.error).toContain("範囲外");

    const outsideRel = await postJson<{ error: string }>("/api/edit/candidate", {
      file: join(root, "..", "uim-outside.txt"),
      instruction: "Change it.",
    });
    expect(outsideRel.res.status).toBe(403);
    expect(outsideRel.body.error).toContain("範囲外");
    expect(claudeMock.complete).not.toHaveBeenCalled();

    const inRootFile = join(root, "src", "read-write.txt");
    writeFileSync(inRootFile, "before", "utf8");
    claudeMock.complete.mockResolvedValueOnce("inside");
    const candidate = await postJson<ProposalBody>("/api/edit/candidate", {
      file: inRootFile,
      instruction: "Change it.",
    });
    expect(candidate.res.status).toBe(200);
    expect(candidate.body.ok).toBe(true);

    const applied = await postJson<{ ok: true }>("/api/edit/apply", {
      proposalId: candidate.body.proposalId,
    });
    expect(applied.res.status).toBe(200);
    expect(readFileSync(inRootFile, "utf8")).toBe("inside");
  });

  it("rejects candidates and applies that escape the root through a symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "uim-symlink-outside-"));
    const swapped = join(root, "src", "swapped.txt");
    try {
      writeFileSync(join(outside, "outside-target.txt"), "outside", "utf8");
      try {
        // Windows の一般ユーザーでも作れる junction を使う(POSIX では type は無視される)。
        symlinkSync(outside, join(root, "src", "escape-dir"), "junction");
        symlinkSync(join(outside, "outside-target.txt"), join(root, "src", "escape-file.txt"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return; // symlink 権限が無い環境
        throw err;
      }

      const viaFileLink = await postJson<{ error: string }>("/api/edit/candidate", {
        file: join(root, "src", "escape-file.txt"),
        instruction: "Change it.",
      });
      expect(viaFileLink.res.status).toBe(403);

      const viaDirLink = await postJson<{ error: string }>("/api/edit/candidate", {
        file: join(root, "src", "escape-dir", "outside-target.txt"),
        instruction: "Change it.",
      });
      expect(viaDirLink.res.status).toBe(403);

      const newViaDirLink = await postJson<{ error: string }>("/api/edit/candidate", {
        file: join(root, "src", "escape-dir", "planted.txt"),
        instruction: "Change it.",
      });
      expect(newViaDirLink.res.status).toBe(403);
      expect(existsSync(join(outside, "planted.txt"))).toBe(false);
      expect(claudeMock.complete).not.toHaveBeenCalled();

      // 候補作成後に対象を root 外への symlink に差し替えても、apply は書き込まない。
      writeFileSync(swapped, "outside", "utf8");
      claudeMock.complete.mockResolvedValueOnce("overwritten");
      const candidate = await postJson<ProposalBody>("/api/edit/candidate", {
        file: swapped,
        instruction: "Change it.",
      });
      expect(candidate.res.status).toBe(200);
      unlinkSync(swapped);
      symlinkSync(join(outside, "outside-target.txt"), swapped);
      const applied = await postJson<{ error: string }>("/api/edit/apply", {
        proposalId: candidate.body.proposalId,
      });
      expect(applied.res.status).toBe(403);
      expect(readFileSync(join(outside, "outside-target.txt"), "utf8")).toBe("outside");
      expect(readdirSync(outside).filter((n) => n.includes(".tmp-"))).toEqual([]);
    } finally {
      rmSync(join(root, "src", "escape-dir"), { force: true });
      rmSync(join(root, "src", "escape-file.txt"), { force: true });
      rmSync(swapped, { force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps the original file when atomic file replacement fails during apply", async () => {
    const proposal = await requestProposal();
    const actualRename = fsPromisesMock.actual.rename;
    const actualUnlink = fsPromisesMock.actual.unlink;
    const unlinked: string[] = [];
    fsPromisesMock.rename.mockImplementation(async (...args: any[]) => {
      if (String(args[1]) === filePath) throw new Error("rename failed");
      return actualRename(...args);
    });
    fsPromisesMock.unlink.mockImplementation(async (...args: any[]) => {
      unlinked.push(String(args[0]));
      return actualUnlink(...args);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await postJson<{ error: string }>("/api/edit/apply", {
        proposalId: proposal.proposalId,
      });

      expect(result.res.status).toBe(500);
      expect(result.body.error).toContain("rename failed");
      expect(readFileSync(filePath, "utf8")).toBe(originalContent);
      expect(unlinked).toHaveLength(1);
      expect(existsSync(unlinked[0])).toBe(false);
      expect(__stores.undoStack).toHaveLength(0);
    } finally {
      errorSpy.mockRestore();
    }
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

describe("git API", () => {
  it("rejects non-string commit messages", async () => {
    const result = await postJson<{ error: string }>("/api/git/commit", {
      message: 42,
    });

    expect(result.res.status).toBe(400);
    expect(result.body.error).toBe(
      "commit message は文字列である必要があります"
    );
  });

  it("returns 409 when there is nothing to commit", async (ctx) => {
    if (!gitAvailable() || !initGitRepo(root)) {
      ctx.skip();
      return;
    }

    const result = await postJson<{ error: string }>("/api/git/commit", {
      message: "No changes",
    });

    expect(result.res.status).toBe(409);
    expect(result.body.error).toBe("コミットする変更がありません");
  }, 15_000);

  it("commits a root merge whose result matches HEAD", async (ctx) => {
    if (!gitAvailable() || !initGitRepo(root)) {
      ctx.skip();
      return;
    }
    const originalHead = String(runGit(["rev-parse", "HEAD"]).stdout).trim();
    const branch = String(runGit(["branch", "--show-current"]).stdout).trim();
    for (const args of [
      ["checkout", "-b", "topic"],
      ["commit", "--allow-empty", "-m", "Topic change"],
      ["checkout", branch],
      ["merge", "--no-commit", "--no-ff", "-s", "ours", "topic"],
    ]) {
      const git = runGit(args);
      expect(git.status, String(git.stderr)).toBe(0);
    }
    const topicHead = String(runGit(["rev-parse", "MERGE_HEAD"]).stdout).trim();
    expect(topicHead).toMatch(/^[0-9a-f]+$/);
    expect(runGit(["diff", "--cached", "--quiet"]).status).toBe(0);

    const result = await postJson<{ ok: true }>("/api/git/commit", {
      message: "Complete merge",
    });

    expect(result.res.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const parents = runGit(["show", "-s", "--format=%P", "HEAD"]);
    expect(String(parents.stdout).trim()).toBe(`${originalHead} ${topicHead}`);
  }, 15_000);

  it("commits working-tree changes after staging them", async (ctx) => {
    if (!gitAvailable() || !initGitRepo(root)) {
      ctx.skip();
      return;
    }
    writeFileSync(filePath, editedContent, "utf8");

    const result = await postJson<{ ok: true }>("/api/git/commit", {
      message: "Apply edit",
    });

    expect(result.res.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(String(runGit(["log", "-1", "--pretty=%B"]).stdout).trim()).toBe(
      "Apply edit"
    );
    expect(String(runGit(["status", "--porcelain"]).stdout).trim()).toBe("");
  }, 15_000);
});

describe("project switch while a history write is in flight", () => {
  it.each(["apply", "undo", "redo"] as const)(
    "lets %s finish and record history before /project/open switches the root",
    async (kind) => {
      const proposal = await requestProposal();
      if (kind !== "apply") {
        await postJson("/api/edit/apply", { proposalId: proposal.proposalId });
      }
      if (kind === "redo") await postJson("/api/edit/undo", {});

      const actualRename = fsPromisesMock.actual.rename;
      const renameStarted = deferred();
      const releaseRename = deferred();
      let delayed = false;
      fsPromisesMock.rename.mockImplementation(async (...args: any[]) => {
        if (!delayed && String(args[1]) === filePath) {
          delayed = true;
          renameStarted.resolve();
          await releaseRename.promise;
        }
        return actualRename(...args);
      });

      const oldRoot = root;
      const oldFilePath = filePath;
      const writePromise = postJson<{ ok?: boolean; error?: string }>(
        kind === "apply" ? "/api/edit/apply" : `/api/edit/${kind}`,
        kind === "apply" ? { proposalId: proposal.proposalId } : {}
      );
      await renameStarted.promise;

      const nextRoot = mkdtempSync(join(tmpdir(), "uim-api-switch-"));
      mkdirSync(join(nextRoot, "src"), { recursive: true });
      writeFileSync(join(nextRoot, "src", "App.tsx"), originalContent, "utf8");
      const openPromise = postJson<{ info?: { root: string } }>(
        "/api/project/open",
        { path: nextRoot, runCommand: "echo test-server-ready" },
        { host: "localhost:5174" }
      );
      await delay(100);
      // 書き込み完了前にルートが切り替わってはならない
      const rootDuringWrite = state.getRoot();
      releaseRename.resolve();
      const result = await writePromise;
      const opened = await openPromise;
      expect(rootDuringWrite).toBe(oldRoot);
      expect(result.res.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        undoDepth: kind === "undo" ? 0 : 1,
      });
      expect(readFileSync(oldFilePath, "utf8")).toBe(
        kind === "undo" ? originalContent : editedContent
      );

      // "echo" は常駐しないので起動自体は失敗し得る。検証対象はルート切替の順序のみ
      expect([200, 500]).toContain(opened.res.status);
      expect(state.getRoot()).toBe(nextRoot);
      root = nextRoot;
      filePath = join(nextRoot, "src", "App.tsx");
      rmSync(oldRoot, { recursive: true, force: true });
    }
  );

  it("rejects history writes with 409 while a project switch is waiting instead of queueing behind it", async () => {
    const proposal = await requestProposal();
    const actualRename = fsPromisesMock.actual.rename;
    const renameStarted = deferred();
    const releaseRename = deferred();
    let delayed = false;
    fsPromisesMock.rename.mockImplementation(async (...args: any[]) => {
      if (!delayed && String(args[1]) === filePath) {
        delayed = true;
        renameStarted.resolve();
        await releaseRename.promise;
      }
      return actualRename(...args);
    });

    const oldRoot = root;
    const writePromise = postJson("/api/edit/apply", { proposalId: proposal.proposalId });
    await renameStarted.promise;

    const nextRoot = mkdtempSync(join(tmpdir(), "uim-api-switch-"));
    mkdirSync(join(nextRoot, "src"), { recursive: true });
    writeFileSync(join(nextRoot, "src", "App.tsx"), originalContent, "utf8");
    const openPromise = postJson(
      "/api/project/open",
      { path: nextRoot, runCommand: "echo test-server-ready" },
      { host: "localhost:5174" }
    );
    await delay(50);

    // 切替待ちの間に来た undo / redo は、切替(dev server 起動を含む)の後ろに並ばず即座に断る
    for (const kind of ["undo", "redo"] as const) {
      const rejected = await postJson<{ error?: string }>(`/api/edit/${kind}`, {});
      expect(rejected.res.status).toBe(409);
      expect(rejected.body.error).toContain("切り替え中");
    }

    releaseRename.resolve();
    expect((await writePromise).res.status).toBe(200);
    await openPromise;
    expect(state.getRoot()).toBe(nextRoot);
    root = nextRoot;
    filePath = join(nextRoot, "src", "App.tsx");
    rmSync(oldRoot, { recursive: true, force: true });
  });
});

describe("internal error details", () => {
  function eacces(path: string): Error {
    return Object.assign(
      new Error(`EACCES: permission denied, open '${path}'`),
      { code: "EACCES", errno: -13, syscall: "open", path }
    );
  }

  it.each(["/api/edit", "/api/edit/stream"] as const)(
    "%s returns a classified message instead of the absolute path on EACCES",
    async (route) => {
      fsPromisesMock.readFile.mockImplementation(async (...args: any[]) => {
        // 提案生成のバイト読み (encoding 指定なし) だけを失敗させる。resolver の utf8 読みは通す
        if (String(args[0]) === filePath && args.length === 1) throw eacces(filePath);
        return fsPromisesMock.actual.readFile(...args);
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const request = {
          descriptor: descriptorFor(filePath),
          instruction: "Change the button label.",
        };
        let error: unknown;
        if (route === "/api/edit") {
          const { body } = await postJson<{ error: string }>(route, request);
          error = body.error;
        } else {
          const { events } = await postSse(route, request);
          error = events.find((event) => event.type === "result")?.error;
        }

        expect(error).toEqual(expect.stringContaining("ソースファイルを読めませんでした"));
        expect(String(error)).not.toContain(root);
        expect(String(error)).not.toContain("EACCES");
        const logged = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
        expect(logged).toContain("EACCES");
      } finally {
        errorSpy.mockRestore();
      }
    }
  );
});

describe("file write hardening", () => {
  const posix = process.platform !== "win32";
  // umask を変えられない環境(worker thread 等)では umask 依存のケースだけ skip する。
  const canSetUmask = (() => {
    if (!posix) return false;
    try {
      process.umask(process.umask(0o022));
      return true;
    } catch {
      return false;
    }
  })();

  async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
    const old = process.umask(mask);
    try {
      return await fn();
    } finally {
      process.umask(old);
    }
  }

  function tempLeftovers(dir: string): string[] {
    return readdirSync(dir).filter((n) => n.includes(".tmp-") || n.includes(".uim-umask-"));
  }

  // HTTP 経路は新規ファイルを作らない(任意パス書き込み API は削除済み)ため、atomicWrite を直接呼んで担保する。
  it.skipIf(!canSetUmask).each([
    [0o022, 0o644],
    [0o077, 0o600],
  ])("atomicWrite creates a new file with 0666 & ~umask (umask %o -> %o)", async (mask, expected) => {
    const dir = join(root, "src");
    const target = join(dir, `brand-new-${mask.toString(8)}.txt`);
    await withUmask(mask, () => atomicWrite(target, "new", root));
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(statSync(target).mode & 0o777).toBe(expected);
    expect(tempLeftovers(dir)).toEqual([]);
  });

  it("atomicWrite creates a new file without leaving temp files", async () => {
    const dir = join(root, "src");
    const target = join(dir, "brand-new.txt");
    await atomicWrite(target, "new", root);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(tempLeftovers(dir)).toEqual([]);
  });

  it("atomicWrite throws for a directory target and leaves it untouched", async () => {
    const dir = join(root, "src");
    const target = join(dir, "a-directory");
    mkdirSync(target);
    const before = readdirSync(dir).sort();
    await expect(atomicWrite(target, "new", root)).rejects.toThrow();
    expect(statSync(target).isDirectory()).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(before);
  });

  it.skipIf(!posix)("atomicWrite creates the temp file for a new file with 0600 before setting the final mode", async () => {
    const actualWriteFile = fsPromisesMock.actual.writeFile;
    const tempModes: number[] = [];
    fsPromisesMock.writeFile.mockImplementation(async (...args: any[]) => {
      const result = await actualWriteFile(...args);
      if (String(args[0]).includes(".tmp-")) {
        tempModes.push(statSync(String(args[0])).mode & 0o777);
      }
      return result;
    });
    const target = join(root, "src", "brand-new.txt");
    await atomicWrite(target, "new", root);
    expect(tempModes).toEqual([0o600]);
    expect(readFileSync(target, "utf8")).toBe("new");
  });

  it.skipIf(!posix)("atomicWrite re-checks the resolved target after a concurrent write to the same file through an alias", async () => {
    mkdirSync(join(root, "real"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    const safe = join(root, "real", "ok.txt");
    const protectedFile = join(root, ".git", "description");
    writeFileSync(safe, "SAFE", "utf8");
    writeFileSync(protectedFile, "GIT_DESCRIPTION", "utf8");
    const alias = join(root, "src", "alias.txt");
    symlinkSync("../real/ok.txt", alias);

    // atomicWrite 自体はロックを持たない(apply は withFileLock で包む)。ここでは両方の一時ファイル
    // 書き込みを止めて「2 本目が 1 本目の完了を待っている」状態を作り、その間に別名を差し替える。
    const actualWriteFile = fsPromisesMock.actual.writeFile;
    const firstStarted = deferred();
    const secondStarted = deferred();
    const release = deferred();
    let started = 0;
    fsPromisesMock.writeFile.mockImplementation(async (...args: any[]) => {
      if (String(args[0]).includes(".tmp-")) {
        started += 1;
        (started === 1 ? firstStarted : secondStarted).resolve();
        await release.promise;
      }
      return actualWriteFile(...args);
    });

    const first = atomicWrite(safe, "FIRST", root);
    await firstStarted.promise;
    const second = atomicWrite(alias, "SECOND", root);
    await secondStarted.promise;
    unlinkSync(alias);
    symlinkSync("../.git/description", alias);
    release.resolve();

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    expect((secondResult as PromiseRejectedResult).reason).toBeInstanceOf(WriteTargetRejectedError);
    expect(readFileSync(protectedFile, "utf8")).toBe("GIT_DESCRIPTION");
    expect(readFileSync(safe, "utf8")).toBe("FIRST");
    expect(readdirSync(join(root, ".git")).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(join(root, "real")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it.skipIf(!posix)("apply re-checks the resolved target when a symlink is swapped mid-write", async () => {
    mkdirSync(join(root, "real"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    const safe = join(root, "real", "ok.txt");
    const protectedFile = join(root, ".git", "description");
    writeFileSync(safe, "SAFE", "utf8");
    writeFileSync(protectedFile, "GIT_DESCRIPTION", "utf8");
    const alias = join(root, "src", "alias.txt");
    symlinkSync("../real/ok.txt", alias);

    claudeMock.complete.mockResolvedValueOnce("SECOND");
    const candidate = await postJson<ProposalBody>("/api/edit/candidate", {
      file: alias,
      instruction: "Change it.",
    });
    expect(candidate.res.status).toBe(200);

    const actualWriteFile = fsPromisesMock.actual.writeFile;
    const writeStarted = deferred();
    const releaseWrite = deferred();
    let blocked = false;
    fsPromisesMock.writeFile.mockImplementation(async (...args: any[]) => {
      if (!blocked && String(args[0]).includes(".tmp-")) {
        blocked = true;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      return actualWriteFile(...args);
    });

    // apply が検査・ロック取得を終えて一時ファイルを書いている間に、alias を保護パスへ差し替える。
    const applying = postJson<{ error: string }>("/api/edit/apply", {
      proposalId: candidate.body.proposalId,
    });
    await writeStarted.promise;
    unlinkSync(alias);
    symlinkSync("../.git/description", alias);
    releaseWrite.resolve();

    const result = await applying;
    expect(result.res.status).toBe(403);
    expect(readFileSync(protectedFile, "utf8")).toBe("GIT_DESCRIPTION");
    expect(readFileSync(safe, "utf8")).toBe("SAFE");
    expect(readdirSync(join(root, ".git")).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(join(root, "real")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});
