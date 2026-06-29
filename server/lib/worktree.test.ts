// ラウンド3: バックエンド ライフサイクル統合テスト (worktree)
// 対象: prepareBefore(root) / cleanup
// 実 git リポジトリ・temp ディレクトリを使う node 環境テスト。
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareBefore, cleanup } from "./worktree.ts";

// --- helpers ---

function gitAvailable(): boolean {
  try {
    const r = spawnSync("git", ["--version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** temp dir を git init してファイルを commit。commit 成功で true。 */
function gitInitAndCommit(dir: string): boolean {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    // ユーザのグローバル/システム設定に依存しないよう固定化
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  const run = (args: string[]) =>
    spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  if (run(["init"]).status !== 0) return false;
  if (run(["add", "."]).status !== 0) return false;
  // -c user.name/email も併記して二重保険(env でも足す)
  const c = run([
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "init",
  ]);
  return c.status === 0;
}

// --- prepareBefore / cleanup ---

describe("prepareBefore / cleanup", () => {
  it("creates a git worktree at HEAD when the project is a git repo (before is immutable)", async (ctx) => {
    if (!gitAvailable()) {
      // git バイナリがない環境: silent pass にしない。ログを残して skip。
      console.log(
        "[skip] git binary is not available; cannot test worktree mode"
      );
      ctx.skip();
      return;
    }
    const root = mkdtempSync(join(tmpdir(), "uim-wt-"));
    try {
      writeFileSync(join(root, "index.html"), "<h1>HEAD</h1>");
      const committed = gitInitAndCommit(root);
      if (!committed) {
        // commit が失敗する環境(GPG・hook 等)では worktree モードを検証できない
        console.log(
          "[skip] git commit failed in this environment; cannot test worktree mode"
        );
        ctx.skip();
        return;
      }

      const h = prepareBefore(root);
      try {
        // mode:'worktree' で別ディレクトリに HEAD の内容が展開される
        expect(h.mode).toBe("worktree");
        expect(h.dir).not.toBe(root);
        expect(existsSync(join(h.dir, "index.html"))).toBe(true);
        expect(readFileSync(join(h.dir, "index.html"), "utf8")).toBe(
          "<h1>HEAD</h1>"
        );

        // 元 dir のファイルを編集しても worktree 側は HEAD のまま(before 不変)
        writeFileSync(join(root, "index.html"), "<h1>EDITED</h1>");
        expect(readFileSync(join(h.dir, "index.html"), "utf8")).toBe(
          "<h1>HEAD</h1>"
        );
      } finally {
        cleanup(h);
        // cleanup() が worktree を後始末し、ディレクトリが削除されていること
        const wtRoot = h.worktreeRoot ?? h.dir;
        expect(existsSync(wtRoot)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("degrades to snapshot or none (no throw) when the dir is not a git repo", () => {
    const root = mkdtempSync(join(tmpdir(), "uim-nogit-"));
    try {
      writeFileSync(join(root, "file.txt"), "hello");
      // git 未init / git バイナリ不可 のどちらでも例外を投げず degrade する
      const h = prepareBefore(root);
      expect(["snapshot", "none"]).toContain(h.mode);

      if (h.mode === "snapshot") {
        // 別ディレクトリに内容がコピーされている
        expect(h.dir).not.toBe(root);
        expect(existsSync(join(h.dir, "file.txt"))).toBe(true);
        expect(readFileSync(join(h.dir, "file.txt"), "utf8")).toBe("hello");
      } else {
        // none の場合は before = after 同一ディレクトリ
        expect(h.dir).toBe(root);
      }

      // 例外を投げずここまで到達したこと( degrade 成功)。cleanup る也例外なし。
      cleanup(h);
      // snapshot の場合は作業ディレクトリが削除されていること(none は noop)
      if (h.mode === "snapshot") {
        expect(existsSync(h.dir)).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
