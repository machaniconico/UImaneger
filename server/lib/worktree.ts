/**
 * 編集前スナップショットを配信するための "before" 配信ディレクトリを準備する。
 *
 * 3 段階の degrade 戦略:
 *   1. worktree : 対象プロジェクトが git 管理下なら HEAD の git worktree を
 *                 一時ディレクトリに作成。HEAD 時点の読み取り専用スナップショット
 *                 となり、作業ツリーの編集が before に波及しない。
 *   2. snapshot : git が使えない場合は作業ツリーを丸ごとコピーした読み取り専用
 *                 ディレクトリを作る。node_modules 等の巨大ディレクトリは除外し
 *                 作業ツリー側を symlink で共有する。
 *   3. none     : 上記も不可なら before=after 同一ディレクトリとする。
 *
 * node_modules は worktree / snapshot 側に存在しないため、作業ツリーの
 * node_modules を symlink で共有して before 側の install をスキップできるようにする。
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";

export type GitMode = "worktree" | "snapshot" | "none";

export interface BeforeHandle {
  /** before を配信するディレクトリ(絶対パス。サブディレクトリ対象ならオフセット済) */
  dir: string;
  mode: GitMode;
  /** オリジナルのプロジェクトルート(絶対パス) */
  root: string;
  /** git worktree で作成したか(snapshot/none では false) */
  worktreeAdded: boolean;
  /** 後始末用: worktree のルート(= git worktree remove 対象)。dir と異なる場合がある。 */
  worktreeRoot?: string;
}

/** 巨大/不要ディレクトリ。snapshot コピー & worktree symlink 対象外。 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".cache",
  ".vite",
  ".turbo",
  "coverage",
]);

const liveBeforeHandles = new Set<BeforeHandle>();

function trackBefore(h: BeforeHandle): BeforeHandle {
  liveBeforeHandles.add(h);
  return h;
}

function runGit(
  root: string,
  args: string[]
): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return {
    ok: r.status === 0,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
}

function isGitRepo(root: string): boolean {
  return runGit(root, ["rev-parse", "--is-inside-work-tree"]).ok;
}

function hasHead(root: string): boolean {
  return runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).ok;
}

/**
 * 作業ツリー(root/node_modules)を dir/node_modules へ symlink する。
 * すでに存在する場合や symlink 失敗(Windows等)は何もしない。
 */
function linkNodeModules(root: string, dir: string): void {
  const rootNm = join(root, "node_modules");
  if (!existsSync(rootNm)) return;
  const dirNm = join(dir, "node_modules");
  if (existsSync(dirNm)) return;
  try {
    symlinkSync(rootNm, dirNm, "dir");
  } catch {
    // symlink 不可環境では静かに無視。before 起動時に install が必要になる可能性がある。
  }
}

/**
 * 編集前スナップショット配信用ディレクトリを準備する。
 * 例外は投げず、最悪でも mode='none' へ degrade する。
 */
export function prepareBefore(root: string): BeforeHandle {
  const absRoot = resolve(root);

  // 1. worktree モード
  if (isGitRepo(absRoot) && hasHead(absRoot)) {
    const wtDir = join(
      tmpdir(),
      `uim-before-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    try {
      // --detach で HEAD を detach して checkout。HEAD 時点の読み取り専用
      // スナップショットとなり、作業ツリーの編集が before に波及しない。
      const r = runGit(absRoot, [
        "worktree",
        "add",
        "--detach",
        "--force",
        wtDir,
        "HEAD",
      ]);
      if (r.ok) {
        // worktree は git ルート全体を checkout する。対象がサブディレクトリの
        // 場合は before 配信ディレクトリをそのオフセット分ずらす。
        const top = runGit(absRoot, ["rev-parse", "--show-toplevel"]);
        const gitRoot = top.ok ? resolve(top.out) : absRoot;
        const rel = relative(gitRoot, absRoot);
        const beforeDir =
          rel && !rel.startsWith("..") ? join(wtDir, rel) : wtDir;
        // 依存解決のため node_modules を symlink:
        //  - git ルート側 (モノレポ/hoisted 依存) を worktree ルートへ
        //  - 対象ディレクトリ固有の node_modules があれば before ディレクトリへ
        linkNodeModules(gitRoot, wtDir);
        if (beforeDir !== wtDir) linkNodeModules(absRoot, beforeDir);
        return trackBefore({
          dir: beforeDir,
          mode: "worktree",
          root: absRoot,
          worktreeAdded: true,
          worktreeRoot: wtDir,
        });
      }
      // 失敗した中間ディレクトリを掃除
      runGit(absRoot, ["worktree", "remove", "--force", wtDir]);
      rmSync(wtDir, { recursive: true, force: true });
    } catch {
      // fall through to snapshot
    }
  }

  // 2. snapshot モード: 作業ツリーをコピー
  const snapDir = join(
    tmpdir(),
    `uim-snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  try {
    mkdirSync(snapDir, { recursive: true });
    cpSync(absRoot, snapDir, {
      recursive: true,
      filter: (src: string) => {
        const base = src.split(/[/\\]/).pop() || "";
        // ルート自身は除外リストに入っている名前で無い限りコピー対象。
        // node_modules/.git 等は subtree ごと除外される。
        return !SKIP_DIRS.has(base) || src === absRoot || src === snapDir;
      },
    });
    linkNodeModules(absRoot, snapDir);
    return trackBefore({
      dir: snapDir,
      mode: "snapshot",
      root: absRoot,
      worktreeAdded: false,
    });
  } catch {
    try {
      rmSync(snapDir, { recursive: true, force: true });
    } catch {
      // ベストエフォート
    }
    // 最終手段: before = after 同じディレクトリ
    return {
      dir: absRoot,
      mode: "none",
      root: absRoot,
      worktreeAdded: false,
    };
  }
}

/**
 * prepareBefore で確保したリソースを解放する。
 * worktree は `git worktree remove` で正しく後始末し、ディレクトリも削除。
 * snapshot はディレクトリを再帰削除。none は何もしない。
 */
export function cleanupBefore(h: BeforeHandle): void {
  liveBeforeHandles.delete(h);
  if (!h || h.mode === "none") return;

  const wtRoot = h.worktreeRoot ?? h.dir;
  if (h.mode === "worktree" && h.worktreeAdded) {
    runGit(h.root, ["worktree", "remove", "--force", wtRoot]);
    // 念のため prune
    runGit(h.root, ["worktree", "prune"]);
  }
  try {
    rmSync(wtRoot, { recursive: true, force: true });
  } catch {
    // ベストエフォート
  }
}

export function cleanupAllBefore(): void {
  for (const h of Array.from(liveBeforeHandles)) {
    try {
      cleanupBefore(h);
    } catch {
      // ベストエフォート
    }
  }
}

export function sweepStaleBeforeDirs(): void {
  let entries: string[];
  try {
    entries = readdirSync(tmpdir());
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!/^uim-(before|snap)-/.test(entry)) continue;
    try {
      rmSync(join(tmpdir(), entry), { recursive: true, force: true });
    } catch {
      // ベストエフォート
    }
  }
}

/** 受入基準が要求する短名エイリアス。cleanupBefore と等価。 */
export const cleanup = cleanupBefore;
