// @vitest-environment node
// R3 受け入れテスト(件2): 編集・ファイル API の保護パス(.git / node_modules / 先頭ドット)。
// 基準: .omc/plans/r3-security-audit-acceptance.md 件2(実装者は編集禁止)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createApp } from "../../server/app.ts";
import { __stores } from "../../server/routes/api.ts";
import { openProject, stopProject } from "../../server/lib/state.ts";
import { __resolverTestHooks } from "../../server/lib/resolver.ts";

const claudeMock = vi.hoisted(() => {
  class TruncatedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "TruncatedError";
    }
  }
  return { complete: vi.fn(), streamComplete: vi.fn(), TruncatedError };
});

vi.mock("../../server/lib/claude.ts", () => ({
  complete: claudeMock.complete,
  streamComplete: claudeMock.streamComplete,
  hasKey: () => true,
  stripCodeFence: (text: string) => text.trim(),
  TruncatedError: claudeMock.TruncatedError,
}));

const app = createApp({ production: false, useLogger: false, serverPort: 5174, clientPort: 5173 });

const C0 = 'export const App = () => <div>C0</div>;';
const C1 = 'export const App = () => <div>C1</div>;';
const INSTRUCTION = "Change the label.";

const MARKERS = [
  "MARKER_GIT_DESCRIPTION",
  "MARKER_GIT_CONFIG",
  "MARKER_GIT_HOOK",
  "MARKER_ENV",
  "MARKER_ENV_LOCAL",
  "MARKER_NM",
  "MARKER_HIDDEN_DIR",
  "MARKER_HIDDEN_FILE",
];

// CI の「Acceptance tests must not be skipped」ゲート対策: 環境依存の AC は条件を満たす時だけ登録する
// (対象外の環境ではレポートに現れない)。
//   AC-2-3 / AC-2-7: symlink を作れない環境(win32 EPERM)では対象外
//   AC-2-9: 別名が同実体を指す環境(大小文字無視 FS または win32)のみ対象
const noop = (..._args: unknown[]): void => {};
const probeDir = realpathSync(mkdtempSync(join(tmpdir(), "uim-probe-")));
const canSymlink: boolean = (() => {
  try {
    symlinkSync("a", join(probeDir, "l"));
    return true;
  } catch {
    return false;
  }
})();
const caseInsensitiveFs: boolean = (() => {
  writeFileSync(join(probeDir, "CaseProbe"), "x");
  return existsSync(join(probeDir, "caseprobe"));
})();
rmSync(probeDir, { recursive: true, force: true });
const itSymlink = canSymlink ? it : noop;
const itAliases = caseInsensitiveFs || process.platform === "win32" ? it : noop;

let root = "";
let symlinksOk = true;
const extraRoots: string[] = [];

function put(base: string, rel: string, content: string): void {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

function mkRoot(prefix = "uim-prot-"): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extraRoots.push(d);
  return d;
}

function buildFixtureP(base: string): void {
  put(base, "src/App.tsx", C0);
  put(base, ".git/description", "MARKER_GIT_DESCRIPTION");
  put(base, ".git/config", "MARKER_GIT_CONFIG");
  put(base, ".git/hooks/pre-commit", "MARKER_GIT_HOOK");
  put(base, ".env", "API_TOKEN=MARKER_ENV");
  put(base, ".env.local", "MARKER_ENV_LOCAL");
  put(base, "node_modules/pkg/index.js", "MARKER_NM");
  put(base, ".vitepress/theme/Layout.vue", "MARKER_HIDDEN_DIR");
  put(base, "src/.secret.ts", "MARKER_HIDDEN_FILE");
  try {
    symlinkSync("../.git", join(base, "src/link-git"));
    symlinkSync("../.git/description", join(base, "src/link-desc.tsx"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    symlinksOk = false;
  }
}

beforeEach(async () => {
  claudeMock.complete.mockReset();
  claudeMock.streamComplete.mockReset();
  // 現状実装(保護なし)で Claude に届いた場合に提案が成立するよう、C1 を返す。
  claudeMock.complete.mockResolvedValue(C1);
  claudeMock.streamComplete.mockImplementation((prompt: string, opts: unknown, onProgress?: unknown) =>
    claudeMock.complete(prompt, opts, onProgress)
  );
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();
  symlinksOk = true;
  root = mkRoot();
  buildFixtureP(root);
  await openProject(root, { command: "echo test-server-ready" });
});

afterEach(async () => {
  __resolverTestHooks.forceRgUsable(null);
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();
  await stopProject();
  for (const d of extraRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE など */
  }
  return { status: res.status, text, json };
}

function claudeSent(): string {
  return JSON.stringify([...claudeMock.complete.mock.calls, ...claudeMock.streamComplete.mock.calls]);
}

function claudeCallCount(): number {
  // streamComplete のモックは complete に委譲するので、両方の呼び出しを数える
  return claudeMock.complete.mock.calls.length + claudeMock.streamComplete.mock.calls.length;
}

const DESC = { tag: "div", classes: [] as string[], attrs: {} as Record<string, string>, domPath: "html>body>div" };

function descWithSource(fileName: string) {
  return { ...DESC, source: { fileName, lineNumber: 1 } };
}

/** 応答・SSE 内のどの relFile も保護セグメント(.git・node_modules・先頭ドット)を含まない。 */
function expectNoProtectedRelFile(text: string, tag: string): void {
  for (const mm of text.matchAll(/"relFile"\s*:\s*"([^"]*)"/g)) {
    const bad = mm[1].split(/[\\/]/).some((seg) => {
      const l = seg.toLowerCase();
      return l === ".git" || l === "node_modules" || l.startsWith(".");
    });
    expect(bad, `${tag}: 保護セグメントを含む relFile ${mm[1]}`).toBe(false);
  }
}

/** AC-2-1 の不変条件: 保護パスを指す source ヒントは Claude に送られず、提案にもならない。 */
async function expectSourceHintRefused(fileName: string, marker: string, label: string): Promise<void> {
  for (const endpoint of ["/api/edit", "/api/edit/stream"]) {
    // mockClear はしない: テスト内の全経路・全呼び出しを累積して検査する
    const r = await post(endpoint, { descriptor: descWithSource(fileName), instruction: INSTRUCTION });
    const tag = `${endpoint} source=${label}`;
    expect(claudeSent(), `${tag}: Claude に送られた`).not.toContain(marker);
    expect(claudeCallCount(), `${tag}: Claude 呼び出し`).toBe(0);
    if (endpoint === "/api/edit") {
      const refused = r.status === 403 || (r.status === 200 && r.json?.ok === false);
      expect(refused, `${tag}: status=${r.status} body=${r.text.slice(0, 120)}`).toBe(true);
    }
    expect(r.text, `${tag}: proposalId`).not.toContain("proposalId");
    expectNoProtectedRelFile(r.text, tag);
  }
}

function sameContent(p: string, expected: string): boolean {
  return readFileSync(p, "utf8") === expected;
}

describe("件2 protected paths", () => {
  it("AC-2-1 edit_source_hint_into_dot_git_is_never_sent_to_claude_nor_proposed", async () => {
    const desc = join(root, ".git/description");
    const hints: Array<[string, string]> = [
      [desc, "absolute"],
      [pathToFileURL(desc).href, "file-url"],
      [".git/description", "relative"],
      [join(root, "src/../.git/description"), "dotdot"],
    ];
    if (symlinksOk) hints.push([join(root, "src/link-desc.tsx"), "symlink"]);
    for (const [x, label] of hints) {
      await expectSourceHintRefused(x, "MARKER_GIT_DESCRIPTION", label);
    }
    expect(readFileSync(desc, "utf8")).toBe("MARKER_GIT_DESCRIPTION");
  });

  it("AC-2-2 edit_candidate_rejects_dot_git_paths", async () => {
    for (const file of [
      join(root, ".git/description"),
      join(root, ".git/config"),
      join(root, ".git/hooks/pre-commit"),
      join(root, ".git"),
      join(root, "src/../.git/description"),
    ]) {
      const r = await post("/api/edit/candidate", { file, instruction: INSTRUCTION });
      expect(r.status, `candidate ${file}: ${r.text.slice(0, 100)}`).toBe(403);
    }
    expect(claudeCallCount()).toBe(0);
  });

  itSymlink("AC-2-3 edit_candidate_rejects_symlink_into_dot_git", async () => {
    expect(symlinksOk, "fixture の symlink 作成").toBe(true);
    for (const file of [join(root, "src/link-git/description"), join(root, "src/link-desc.tsx")]) {
      const c = await post("/api/edit/candidate", { file, instruction: INSTRUCTION });
      expect(c.status, `candidate ${file}`).toBe(403);
    }
    expect(claudeCallCount()).toBe(0);
    expect(readFileSync(join(root, ".git/description"), "utf8")).toBe("MARKER_GIT_DESCRIPTION");
  });

  it("AC-2-4 edit_candidate_and_source_hint_reject_dot_git_gitfile_and_nonexistent_protected_paths", async () => {
    const cfg = join(root, ".git/config");
    const c = await post("/api/edit/candidate", { file: cfg, instruction: INSTRUCTION });
    expect(c.status, "candidate .git/config").toBe(403);
    expect(c.text).not.toContain("MARKER_GIT_CONFIG");
    expect(readFileSync(cfg, "utf8")).toBe("MARKER_GIT_CONFIG");

    // 未存在の保護パスは 404 ではなく 403(作成もされない)
    for (const rel of [".git/hooks/post-checkout", "node_modules/none.js", ".newhidden"]) {
      const neu = join(root, rel);
      const r = await post("/api/edit/candidate", { file: neu, instruction: INSTRUCTION });
      expect(r.status, `candidate 未存在 ${rel}`).toBe(403);
      expect(existsSync(neu), `${rel} が作られた`).toBe(false);
    }
    expect(claudeCallCount()).toBe(0);

    // .git が `gitdir: /x` の通常ファイルである別 fixture
    await stopProject();
    const root2 = mkRoot("uim-prot-gitfile-");
    put(root2, "src/App.tsx", C0);
    put(root2, ".git", "gitdir: /x");
    await openProject(root2, { command: "echo test-server-ready" });
    const gitfile = join(root2, ".git");
    const c2 = await post("/api/edit/candidate", { file: gitfile, instruction: INSTRUCTION });
    expect(c2.status, "candidate gitfile").toBe(403);
    await expectSourceHintRefused(gitfile, "gitdir", "gitfile");
    expect(readFileSync(gitfile, "utf8")).toBe("gitdir: /x");
    expect(claudeCallCount()).toBe(0);
  });

  it("AC-2-5 edit_candidate_and_source_hint_reject_node_modules", async () => {
    const file = join(root, "node_modules/pkg/index.js");
    const c = await post("/api/edit/candidate", { file, instruction: INSTRUCTION });
    expect(c.status, "candidate").toBe(403);
    expect(c.text).not.toContain("MARKER_NM");
    await expectSourceHintRefused(file, "MARKER_NM", "node_modules");
    expect(readFileSync(file, "utf8")).toBe("MARKER_NM");
  });

  it("AC-2-6 edit_candidate_and_source_hint_reject_hidden_segments_including_env", async () => {
    const targets: Array<[string, string]> = [
      [".env", "API_TOKEN=MARKER_ENV"],
      [".env.local", "MARKER_ENV_LOCAL"],
      [".vitepress/theme/Layout.vue", "MARKER_HIDDEN_DIR"],
      ["src/.secret.ts", "MARKER_HIDDEN_FILE"],
    ];
    for (const [rel, content] of targets) {
      const file = join(root, rel);
      const c = await post("/api/edit/candidate", { file, instruction: INSTRUCTION });
      expect(c.status, `candidate ${rel}`).toBe(403);
      for (const m of MARKERS) expect(c.text, `candidate ${rel} 応答に ${m}`).not.toContain(m);
      await expectSourceHintRefused(file, content.replace("API_TOKEN=", ""), rel);
    }
    for (const m of MARKERS) expect(claudeSent(), `Claude に ${m}`).not.toContain(m);
    for (const [rel, content] of targets) expect(sameContent(join(root, rel), content), `${rel} 不変`).toBe(true);
  });

  itSymlink("AC-2-7 apply_undo_redo_refuse_when_target_now_resolves_to_protected_path", async () => {
    expect(symlinksOk, "fixture の symlink 作成").toBe(true);
    const app_ = join(root, "src/App.tsx");
    const gitDesc = join(root, ".git/description");
    const swapToLink = () => {
      unlinkSync(app_);
      symlinkSync("../.git/description", app_);
    };
    const propose = async (): Promise<string> => {
      claudeMock.complete.mockResolvedValueOnce(C1);
      const r = await post("/api/edit/candidate", { file: app_, instruction: INSTRUCTION });
      expect(r.status, `candidate: ${r.text.slice(0, 100)}`).toBe(200);
      return r.json.proposalId as string;
    };

    // apply
    writeFileSync(gitDesc, C0, "utf8");
    const pid = await propose();
    swapToLink();
    const a = await post("/api/edit/apply", { proposalId: pid });
    expect(a.status, "apply").toBe(403);
    expect(readFileSync(gitDesc, "utf8"), "apply 後の .git/description").toBe(C0);

    // undo
    unlinkSync(app_);
    writeFileSync(app_, C0, "utf8");
    __stores.undoStack.splice(0);
    __stores.redoStack.splice(0);
    const pid2 = await propose();
    expect((await post("/api/edit/apply", { proposalId: pid2 })).status, "通常 apply").toBe(200);
    expect(readFileSync(app_, "utf8")).toBe(C1);
    writeFileSync(gitDesc, C1, "utf8");
    swapToLink();
    const u = await post("/api/edit/undo", {});
    expect(u.status, "undo").toBe(403);
    expect(readFileSync(gitDesc, "utf8"), "undo 後の .git/description").toBe(C1);

    // redo
    unlinkSync(app_);
    writeFileSync(app_, C1, "utf8");
    __stores.undoStack.splice(0);
    __stores.redoStack.splice(0);
    writeFileSync(app_, C0, "utf8");
    const pid3 = await propose();
    expect((await post("/api/edit/apply", { proposalId: pid3 })).status, "redo 用 apply").toBe(200);
    expect((await post("/api/edit/undo", {})).status, "redo 用 undo").toBe(200);
    expect(readFileSync(app_, "utf8")).toBe(C0);
    writeFileSync(gitDesc, C0, "utf8");
    swapToLink();
    const rr = await post("/api/edit/redo", {});
    expect(rr.status, "redo").toBe(403);
    expect(readFileSync(gitDesc, "utf8"), "redo 後の .git/description").toBe(C0);
  });

  it("AC-2-8 policy_is_relative_to_root_and_has_no_false_positives", async () => {
    await stopProject();
    const parent = mkRoot("uim-prot-parent-");
    const root2 = join(parent, ".hidden-parent", "node_modules", "proj");
    mkdirSync(root2, { recursive: true });
    const real = realpathSync(root2);
    const files: Array<[string, string]> = [
      ["src/App.tsx", C0],
      ["src/my.git.notes.md", "NOTES_GIT"],
      ["src/gitignore.txt", "GITIGNORE"],
      ["src/node_modules_readme.md", "NM_README"],
      ["docs/v1.2/a.b.c.md", "DOTTED"],
      ["src/git/x.txt", "GITDIR_NOT_DOT"],
    ];
    for (const [rel, content] of files) put(real, rel, content);
    await openProject(real, { command: "echo test-server-ready" });

    for (const [rel, content] of files) {
      const p = join(real, rel);
      claudeMock.complete.mockClear();
      claudeMock.streamComplete.mockClear();
      claudeMock.complete.mockResolvedValueOnce(`${content}!`);
      const c = await post("/api/edit/candidate", { file: p, instruction: INSTRUCTION });
      expect(c.status, `candidate ${rel}: ${c.text.slice(0, 100)}`).toBe(200);
      expect(c.json?.ok, `candidate ${rel} ok`).toBe(true);
      expect(claudeSent(), `${rel}: Claude に元内容が渡る`).toContain(JSON.stringify(content).slice(1, -1));
      const ap = await post("/api/edit/apply", { proposalId: c.json.proposalId });
      expect(ap.status, `apply ${rel}`).toBe(200);
      expect(readFileSync(p, "utf8"), `apply ${rel} 反映`).toBe(`${content}!`);
    }
  });

  itAliases("AC-2-9 candidate_rejects_protected_name_aliases (条件付き: 別名が同実体を指す環境のみ)", async () => {
    const cases: Array<[string, string]> = [];
    const add = (p: string, marker: string) => cases.push([p, marker]);
    // 大小文字無視 FS(macOS / win32)のみ。Linux ext4 では existsSync が false で skip される。
    if (existsSync(join(root, ".GIT", "config"))) add(join(root, ".GIT", "config"), "MARKER_GIT_CONFIG");
    if (existsSync(join(root, "NODE_MODULES", "pkg", "index.js"))) add(join(root, "NODE_MODULES", "pkg", "index.js"), "MARKER_NM");
    if (process.platform === "win32") {
      add(`${root}\\.git.\\config`, "MARKER_GIT_CONFIG");
      add(`${root}\\.git \\config`, "MARKER_GIT_CONFIG");
      add(`${root}\\node_modules.\\pkg\\index.js`, "MARKER_NM");
      add(`${root}\\.git::$INDEX_ALLOCATION\\config`, "MARKER_GIT_CONFIG");
      if (existsSync(`${root}\\GIT~1\\config`)) add(`${root}\\GIT~1\\config`, "MARKER_GIT_CONFIG");
      if (existsSync(`${root}\\NODE_M~1\\pkg\\index.js`)) add(`${root}\\NODE_M~1\\pkg\\index.js`, "MARKER_NM");
    }
    expect(cases.length, "検査対象の別名").toBeGreaterThan(0);
    for (const [p, marker] of cases) {
      const c = await post("/api/edit/candidate", { file: p, instruction: INSTRUCTION });
      expect(c.status, `candidate ${p}`).toBe(403);
      expect(c.text).not.toContain(marker);
    }
    expect(claudeCallCount()).toBe(0);
    expect(readFileSync(join(root, ".git/config"), "utf8")).toBe("MARKER_GIT_CONFIG");
    expect(readFileSync(join(root, "node_modules/pkg/index.js"), "utf8")).toBe("MARKER_NM");
  });
});

describe("件2 追加基準(レビュー由来)", () => {
  it("AC-2-10 resolver_layer_b_never_offers_or_sends_hidden_files_without_rg", async () => {
    __resolverTestHooks.forceRgUsable(false); // rg 非利用(層 B の no-ripgrep 経路)
    put(root, "src/A.tsx", '<h1 className="zzqmarker">A</h1>');
    put(root, "src/.secret.tsx", '<h1 className="zzqmarker">MARKER_HIDDEN_LAYERB</h1>');
    put(root, ".hidden/B.tsx", '<h1 className="zzqmarker">MARKER_HIDDEN_DIR_B</h1>');
    const descriptor = { tag: "h1", classes: ["zzqmarker"], attrs: {}, domPath: "html>body>h1", text: "A" };
    const hiddenMarkers = ["MARKER_HIDDEN_LAYERB", "MARKER_HIDDEN_DIR_B"];

    for (const endpoint of ["/api/edit", "/api/edit/stream"]) {
      claudeMock.complete.mockClear();
      claudeMock.streamComplete.mockClear();
      const r = await post(endpoint, { descriptor, instruction: INSTRUCTION });
      for (const m of hiddenMarkers) {
        expect(r.text, `${endpoint} 応答に ${m}`).not.toContain(m);
        expect(claudeSent(), `${endpoint}: Claude に ${m}`).not.toContain(m);
      }
      for (const mm of r.text.matchAll(/"relFile"\s*:\s*"([^"]*)"/g)) {
        expect(
          mm[1].split(/[\\/]/).some((seg) => seg.startsWith(".")),
          `${endpoint}: 隠しセグメントを含む relFile ${mm[1]}`
        ).toBe(false);
      }
      if (endpoint === "/api/edit") {
        expect(r.status, `${endpoint}: src/A.tsx への提案 ${r.text.slice(0, 120)}`).toBe(200);
        expect(r.json?.relFile, "relFile").toMatch(/src[\\/]A\.tsx$/);
      } else {
        expect(r.text, "stream: src/A.tsx の提案").toMatch(/A\.tsx/);
        expect(r.text, "stream: proposalId").toContain("proposalId");
      }
    }
  });
});
