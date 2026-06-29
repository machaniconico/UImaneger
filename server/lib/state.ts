import { basename } from "node:path";
import { type ChildProcess } from "node:child_process";
import {
  startTarget,
  findFreePort,
  detectRunner,
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
  // --- legacy aliases (= after 側) 下位互換 ---
  target: RunningTarget | null;
  proxy: ProxyHandle | null;
}

let session: Session | null = null;

function signalGroup(
  proc: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // プロセスグループ kill に失敗したらフォールバック
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // 既に終了済みなら無視
  }
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(proc)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      proc.off("exit", onExit);
      proc.off("error", onError);
      resolve(ok);
    };
    const onExit = () => done(true);
    const onError = () => {
      if (hasExited(proc)) done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    proc.once("exit", onExit);
    proc.once("error", onError);
    if (hasExited(proc)) done(true);
  });
}

async function killGroup(proc: ChildProcess): Promise<void> {
  signalGroup(proc, "SIGTERM");
  const exited = await waitForExit(proc, 3_000);
  if (exited) return;
  signalGroup(proc, "SIGKILL");
  await waitForExit(proc, 1_000);
}

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
    // sharedContract (before/after 二重配信)
    beforeProxyPort: session.proxyBefore?.port ?? null,
    afterProxyPort: session.proxyAfter?.port ?? null,
    targetPortBefore: session.targetBefore?.port ?? null,
    targetPortAfter: session.targetAfter?.port ?? null,
    gitMode: session.gitMode,
  };
}

export function getRoot(): string | null {
  return session?.root ?? null;
}

export async function openProject(
  root: string,
  override?: { command?: string; framework?: string }
): Promise<ProjectInfo> {
  await stopProject();
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
    target: null,
    proxy: null,
  };
  return getInfo()!;
}

export async function startProject(): Promise<ProjectInfo> {
  if (!session) throw new Error("プロジェクトが開かれていません。");
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
      session.proxyBefore = null;
    }
  }

  return getInfo()!;
  } catch (e) {
    await stopProject().catch(() => {});
    throw e;
  }
}

export async function stopProject(): Promise<void> {
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
}

export function getLogs(): string[] {
  return session?.targetAfter?.logs ?? [];
}
