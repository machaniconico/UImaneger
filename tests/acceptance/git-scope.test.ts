// @vitest-environment node
// R3 受け入れテスト(件3): サブディレクトリを開いた時の Git 範囲(status / commit は project root 内のみ)。
// 基準: .omc/plans/r3-security-audit-acceptance.md 件3(実装者は編集禁止)
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp } from "../../server/app.ts";
import { __stores } from "../../server/routes/api.ts";
import { openProject, stopProject } from "../../server/lib/state.ts";

vi.mock("../../server/lib/claude.ts", () => ({
  complete: vi.fn(),
  streamComplete: vi.fn(),
  hasKey: () => true,
  stripCodeFence: (text: string) => text.trim(),
  TruncatedError: class TruncatedError extends Error {},
}));

const app = createApp({ production: false, useLogger: false, serverPort: 5174, clientPort: 5173 });

function gitAvailable(): boolean {
  try {
    return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}
const hasGit = gitAvailable();

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
  if (r.status !== 0 && args[0] !== "status") throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return String(r.stdout);
}

function put(repo: string, rel: string, content: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

let repo = "";

/** fixture G: 親リポジトリ(初回コミット済み)に app/a.txt, sibling/s.txt, sibling/s2.txt, root.txt */
function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "uim-gitscope-")));
  git(["init"], dir);
  git(["config", "user.name", "test"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "commit.gpgsign", "false"], dir);
  put(dir, "app/a.txt", "a0\n");
  put(dir, "sibling/s.txt", "s0\n");
  put(dir, "sibling/s2.txt", "s20\n");
  put(dir, "root.txt", "r0\n");
  git(["add", "."], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

async function postCommit(message = "m"): Promise<{ status: number; json: any }> {
  const res = await app.request("/api/git/commit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function getStatus(): Promise<{ status: number; changes: string[] }> {
  const res = await app.request("/api/git/status");
  const j: any = await res.json();
  return { status: res.status, changes: j.changes ?? [] };
}

const headFiles = (): string[] =>
  git(["show", "--name-only", "--format=", "HEAD"], repo).split("\n").filter(Boolean).sort();
const headSha = (): string => git(["rev-parse", "HEAD"], repo).trim();
const parentStatus = (): string => git(["status", "--porcelain"], repo);

beforeEach(() => {
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();
  repo = hasGit ? makeRepo() : "";
});

afterEach(async () => {
  await stopProject();
  if (repo) rmSync(repo, { recursive: true, force: true });
});

// git が無い環境ではこのファイルの AC は登録されない(対象外。skip ゲート対策)。
if (hasGit) describe("件3 git scope", () => {
  it("AC-3-1 git_commit_in_subdir_project_excludes_sibling_and_parent_changes", async () => {
    await openProject(join(repo, "app"), { command: "echo test-server-ready" });
    put(repo, "app/a.txt", "a1\n");
    put(repo, "sibling/s.txt", "s1\n");
    put(repo, "sibling/new.txt", "new\n");
    put(repo, "untracked.txt", "u\n");

    const r = await postCommit();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(headFiles()).toEqual(["app/a.txt"]);
    const st = parentStatus();
    expect(st).toContain(" M sibling/s.txt");
    expect(st).toContain("?? sibling/new.txt");
    expect(st).toContain("?? untracked.txt");
  }, 20_000);

  it("AC-3-2 git_commit_leaves_prestaged_sibling_changes_staged_and_uncommitted", async () => {
    await openProject(join(repo, "app"), { command: "echo test-server-ready" });
    put(repo, "sibling/s2.txt", "s21\n");
    git(["add", "sibling/s2.txt"], repo);
    put(repo, "app/a.txt", "a1\n");

    const r = await postCommit();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(headFiles()).toEqual(["app/a.txt"]);
    expect(git(["diff", "--cached", "--name-only"], repo).split("\n").filter(Boolean)).toEqual(["sibling/s2.txt"]);
  }, 20_000);

  it("AC-3-3 git_commit_returns_409_when_only_out_of_scope_changes_exist", async () => {
    await openProject(join(repo, "app"), { command: "echo test-server-ready" });

    // (a) sibling/s.txt だけ変更(未ステージ)
    put(repo, "sibling/s.txt", "s1\n");
    let sha = headSha();
    let before = parentStatus();
    const a = await postCommit();
    expect(a.status, `(a) ${JSON.stringify(a.json)}`).toBe(409);
    expect(headSha(), "(a) HEAD 不変").toBe(sha);
    expect(parentStatus(), "(a) 親の status 不変").toBe(before);

    // (b) sibling/s2.txt の変更がステージ済み((a) の s.txt 変更も残ったまま)
    put(repo, "sibling/s2.txt", "s21\n");
    git(["add", "sibling/s2.txt"], repo);
    sha = headSha();
    before = parentStatus();
    const b = await postCommit();
    expect(b.status, `(b) ${JSON.stringify(b.json)}`).toBe(409);
    expect(headSha(), "(b) HEAD 不変").toBe(sha);
    expect(parentStatus(), "(b) 親の status 不変").toBe(before);
  }, 20_000);

  it("AC-3-4 git_status_in_subdir_project_lists_only_project_changes", async () => {
    await openProject(join(repo, "app"), { command: "echo test-server-ready" });
    put(repo, "app/a.txt", "a1\n");
    put(repo, "app/new.txt", "n\n");
    put(repo, "sibling/s.txt", "s1\n");
    put(repo, "sibling/s2.txt", "s21\n");
    git(["add", "sibling/s2.txt"], repo);
    put(repo, "root.txt", "r1\n");

    const s = await getStatus();
    expect(s.status).toBe(200);
    expect(s.changes, JSON.stringify(s.changes)).toHaveLength(2);
    expect(s.changes.some((l) => l.includes("a.txt"))).toBe(true);
    expect(s.changes.some((l) => l.includes("new.txt"))).toBe(true);
    expect(s.changes.some((l) => l.includes("sibling") || l.includes("root.txt"))).toBe(false);

    const r = await postCommit();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(headFiles()).toEqual(["app/a.txt", "app/new.txt"]);
  }, 20_000);

  it("AC-3-5 git_scope_unchanged_when_project_root_is_repo_toplevel", async () => {
    await openProject(repo, { command: "echo test-server-ready" });
    put(repo, "app/a.txt", "a1\n");
    put(repo, "sibling/new.txt", "n\n");

    const s = await getStatus();
    expect(s.changes, JSON.stringify(s.changes)).toHaveLength(2);
    const r = await postCommit();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(headFiles()).toEqual(["app/a.txt", "sibling/new.txt"]);
    expect((await getStatus()).changes).toHaveLength(0);
  }, 20_000);

  /** feat と main で conflict.txt を衝突させ、マージ中(未解消)の状態にする。 */
  function startConflictedMerge(): void {
    git(["checkout", "-q", "-b", "feat"], repo);
    put(repo, "conflict.txt", "feat\n");
    git(["add", "."], repo);
    git(["commit", "-m", "feat"], repo);
    git(["checkout", "-q", "-"], repo);
    put(repo, "conflict.txt", "main\n");
    git(["add", "."], repo);
    git(["commit", "-m", "main"], repo);
    const r = spawnSync("git", ["merge", "feat"], { cwd: repo, encoding: "utf8" });
    expect(r.status, "git merge feat は衝突で失敗するはず").not.toBe(0);
  }

  it("AC-3-6 git_commit_completes_a_resolved_merge_at_repo_toplevel", async () => {
    // 基準追加: 追加基準(レビュー由来)
    put(repo, "conflict.txt", "base\n");
    git(["add", "."], repo);
    git(["commit", "-m", "base"], repo);
    startConflictedMerge();
    put(repo, "conflict.txt", "resolved\n"); // 衝突を解消して保存(add はしない)
    await openProject(repo, { command: "echo test-server-ready" });

    const r = await postCommit("merge");
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const parents = git(["rev-list", "--parents", "-n", "1", "HEAD"], repo).trim().split(" ");
    expect(parents.length - 1, "HEAD の親の数(マージコミット)").toBe(2);
    expect(parentStatus().trim(), "コミット後の status").toBe("");
  }, 20_000);

  it("AC-3-7 git_commit_during_merge_in_subdir_returns_409_without_side_effects", async () => {
    put(repo, "conflict.txt", "base\n");
    git(["add", "."], repo);
    git(["commit", "-m", "base"], repo);
    startConflictedMerge();
    await openProject(join(repo, "app"), { command: "echo test-server-ready" });
    put(repo, "app/a.txt", "a1\n");

    const sha = headSha();
    const before = parentStatus();
    const mergeHead = join(repo, ".git", "MERGE_HEAD");
    expect(existsSync(mergeHead), "前提: MERGE_HEAD あり").toBe(true);

    const r = await postCommit("sub");
    expect(r.status, JSON.stringify(r.json)).toBe(409);
    expect(String(r.json?.error ?? ""), "日本語の理由").toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
    expect(String(r.json?.error ?? ""), "マージ中の理由").toContain("マージ");
    expect(headSha(), "HEAD 不変").toBe(sha);
    expect(parentStatus(), "status 不変").toBe(before);
    expect(existsSync(mergeHead), "MERGE_HEAD 不変").toBe(true);
  }, 20_000);
});
