import { basename } from "node:path";
import {
  startTarget,
  findFreePort,
  detectRunner,
  killGroup,
  type RunningTarget,
} from "./runner.ts";
import { startProxy, type ProxyHandle } from "./proxy.ts";
import {
  prepareBefore,
  cleanupBefore,
  type BeforeHandle,
  type GitMode,
} from "./worktree.ts";
import type { ProjectInfo } from "./types.ts";

interface Session {
  root: string;
  framework: string;
  runCommand: string;
  /** before 配信ディレクトリ(worktree/snapshot/none) */
  before: BeforeHandle | null;
  /** 編集前スナップショット配信 dev server */
  targetBefore: RunningTarget | null;
  /** 変更後(実作業ツリー)配信 dev server */
  targetAfter: RunningTarget | null;
  /** before 配信プロキシ */
  proxyBefore: ProxyHandle | null;
  /** after 配信プロキシ */
  proxyAfter: ProxyHandle | null;
  gitMode: GitMode | null;
  /** before プレビュー起動失敗時のメッセージ(成功時は null) */
  beforeError: string | null;
  // --- legacy aliases (= after 側) 下位互換 ---
  target: RunningTarget | null;
  proxy: ProxyHandle | null;
}

let session: Session | null = null;

// --- S3: セッションライフサイクルを直列化する promise-chain mutex ---
// openProject/startProject/stopProject はこのロック経由で1本ずつ実行される。
// 世代カウンタ/kill-on-supersede は使わず、単純な直列化で競合を排除する。
let lifecycle: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lifecycle.then(fn, fn);
  // チェーンは成功/失敗どちらでも消化して次を詰まらせない
  lifecycle = run.then(
    () => {},
    () => {}
  );
  return run as Promise<T>;
}

// =========================================================================
// 内部(アンロック)実装: ロック内からのみ呼ぶ。catch 内の後始末は
// ロック済コンテキストで動くため、ネストロックを避けて _stopProject を直接呼ぶ。
// =========================================================================

async function _openProject(
  root: string,
  override?: { command?: string; framework?: string }
): Promise<ProjectInfo> {
  // 既存セッションがあればアンロック版で後始末(ネストロック禁止)
  await _stopProject();
  const plan = detectRunner(root, 0, override);
  session = {
    root,
    framework: plan.framework,
    runCommand: `${plan.command} ${plan.args.join(" ")}`,
    before: null,
    targetBefore: null,
    targetAfter: null,
    proxyBefore: null,
    proxyAfter: null,
    gitMode: null,
    beforeError: null,
    target: null,
    proxy: null,
  };
  return getInfo()!;
}

async function _startProject(): Promise<ProjectInfo> {
  if (!session) throw new Error("プロジェクトが開かれていません。");
  // 2本目の並行 start はここで短絡する(直列化されているので最初の start 完了後)
  if (session.targetAfter && session.proxyAfter) return getInfo()!;

  try {
  // before 配信ディレクトリ準備 (worktree/snapshot/none)
  // 例外は投げない想定だが、万が一落ちたら none へ。
  let before: BeforeHandle;
  try {
    before = prepareBefore(session.root);
  } catch {
    before = {
      dir: session.root,
      mode: "none",
      root: session.root,
      worktreeAdded: false,
    };
  }
  session.before = before;
  session.gitMode = before.mode;
  const beforeDir = before.dir;
  const sameDirAsAfter = beforeDir === session.root;

  // before 起動失敗可視化: 成功時は null にリセット
  session.beforeError = null;

  // --- after (実作業ツリー) 起動 ---
  const afterPort = await findFreePort(5180);
  const targetAfter = await startTarget(session.root, afterPort, {
    command: undefined,
    framework: session.framework,
  });
  session.targetAfter = targetAfter;
  session.target = targetAfter; // legacy alias
  session.framework = targetAfter.plan.framework;
  session.runCommand = `${targetAfter.plan.command} ${targetAfter.plan.args.join(
    " "
  )}`;

  // --- before (HEAD/snapshot) 起動 ---
  // none モードでは before=after 同一ディレクトリなので別プロセスは起動せず、
  // after の RunningTarget をそのまま before として見なす(before=after 同一)。
  if (sameDirAsAfter) {
    session.targetBefore = targetAfter;
  } else {
    try {
      const beforePort = await findFreePort(5190);
      session.targetBefore = await startTarget(beforeDir, beforePort, {
        command: undefined,
        framework: session.framework,
      });
    } catch (e) {
      // before 起動失敗時は after を維持し、proxy も before 側は出さない。
      console.warn("[UImaneger] before target 起動失敗:", e);
      session.beforeError = `編集前プレビュー起動失敗: ${String(
        (e as any)?.message ?? e
      )}`;
      session.targetBefore = null;
    }
  }

  // --- プロキシ起動: after ---
  const afterProxyPort = await findFreePort(6100);
  session.proxyAfter = await startProxy(targetAfter.port, afterProxyPort);
  session.proxy = session.proxyAfter; // legacy alias

  // --- プロキシ起動: before ---
  // targetBefore が無ければ before プロキシも無し(none モードでは targetBefore === after なので
  // 同一内容を別ポートで提供する = "before=after 同一を指す" 仕様)。
  if (session.targetBefore) {
    try {
      const beforeProxyPort = await findFreePort(6110);
      session.proxyBefore = await startProxy(
        session.targetBefore.port,
        beforeProxyPort
      );
    } catch (e) {
      console.warn("[UImaneger] before proxy 起動失敗:", e);
      session.beforeError = `編集前プレビュー起動失敗: ${String(
        (e as any)?.message ?? e
      )}`;
      session.proxyBefore = null;
    }
  }

  return getInfo()!;
  } catch (e) {
    // catch 内はアンロック版を呼ぶ(ネストロック禁止)
    await _stopProject().catch(() => {});
    throw e;
  }
}

async function _stopProject(): Promise<void> {
  if (!session) return;

  // before プロキシ停止 (after と別物のみ)
  if (session.proxyBefore) {
    await session.proxyBefore.close().catch(() => {});
    session.proxyBefore = null;
  }
  // after プロキシ停止
  if (session.proxyAfter) {
    await session.proxyAfter.close().catch(() => {});
    session.proxyAfter = null;
    session.proxy = null;
  }

  // before ターゲット停止 (none モード時は after と同一オブジェクトなので after 側で停止)
  const killTasks: Promise<void>[] = [];
  const sharedTarget = session.targetBefore === session.targetAfter;
  if (session.targetBefore && session.targetBefore !== session.targetAfter) {
    killTasks.push(killGroup(session.targetBefore.proc));
    session.targetBefore = null;
  }
  // after ターゲット停止
  if (session.targetAfter) {
    killTasks.push(killGroup(session.targetAfter.proc));
    session.targetAfter = null;
    session.target = null;
    if (sharedTarget) session.targetBefore = null;
  }
  await Promise.all(killTasks);

  // worktree / snapshot 後始末
  if (session.before) {
    cleanupBefore(session.before);
    session.before = null;
  }
  session.gitMode = null;
  session.beforeError = null;
}

// =========================================================================
// 公開 API: 全て withLock で直列化する。
// =========================================================================

export function getInfo(): ProjectInfo | null {
  if (!session) return null;
  return {
    root: session.root,
    name: basename(session.root),
    framework: session.framework,
    runCommand: session.runCommand,
    // legacy (after 側)
    targetPort: session.targetAfter?.port ?? null,
    proxyPort: session.proxyAfter?.port ?? null,
    running: Boolean(session.targetAfter && session.proxyAfter),
    // shared_contract (before/after 二重配信)
    beforeProxyPort: session.proxyBefore?.port ?? null,
    afterProxyPort: session.proxyAfter?.port ?? null,
    targetPortBefore: session.targetBefore?.port ?? null,
    targetPortAfter: session.targetAfter?.port ?? null,
    gitMode: session.gitMode,
    beforeError: session.beforeError,
  };
}

export function getRoot(): string | null {
  return session?.root ?? null;
}

export function openProject(
  root: string,
  override?: { command?: string; framework?: string }
): Promise<ProjectInfo> {
  return withLock(() => _openProject(root, override));
}

export function startProject(): Promise<ProjectInfo> {
  return withLock(() => _startProject());
}

export function stopProject(): Promise<void> {
  return withLock(() => _stopProject());
}

/**
 * openProject → startProject を1つのロック区間で連続実行する。
 * これにより open と start の間に別のライフサイクル操作が割り込むのを防ぐ。
 */
export function openAndStart(
  root: string,
  override?: { command?: string; framework?: string }
): Promise<ProjectInfo> {
  return withLock(async () => {
    await _openProject(root, override);
    return _startProject();
  });
}

export function getLogs(): string[] {
  return session?.targetAfter?.logs ?? [];
}
