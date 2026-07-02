// S3/S6: セッションライフサイクルの直列化 / beforeError 可視化のテスト。
// runner/proxy/worktree は vi.mock で差し替え、public interface 経由で振る舞いを検証。
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  openProject,
  startProject,
  stopProject,
  openAndStart,
  getInfo,
  getRoot,
} from "./state.ts";
import { startTarget, findFreePort } from "./runner.ts";
import { startProxy } from "./proxy.ts";
import { prepareBefore, cleanupBefore } from "./worktree.ts";

// --- mocks ---
vi.mock("./runner.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./runner.ts")>();
  return {
    ...actual,
    startTarget: vi.fn(),
    findFreePort: vi.fn(),
  };
});
vi.mock("./proxy.ts", () => ({ startProxy: vi.fn() }));
vi.mock("./worktree.ts", () => ({
  prepareBefore: vi.fn(),
  cleanupBefore: vi.fn(),
}));

// --- fake proc: killGroup(signalGroup→proc.kill) で即 exit 扱いにする ---
interface FakeProc {
  proc: ChildProcess;
  killed: boolean;
}
function makeFakeProc(): FakeProc {
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const proc = {
    pid: 0,
    get exitCode() {
      return exitCode;
    },
    set exitCode(v: number | null) {
      exitCode = v;
    },
    get signalCode() {
      return signalCode;
    },
    set signalCode(v: NodeJS.Signals | null) {
      signalCode = v;
    },
    kill(signal?: NodeJS.Signals) {
      if (exitCode === null && signalCode === null) {
        exitCode = 0;
        for (const h of handlers.exit ?? []) h(0, signal);
      }
      return true;
    },
    on(ev: string, h: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(h);
      return proc;
    },
    once(ev: string, h: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(h);
      return proc;
    },
    off(ev: string, h: (...a: unknown[]) => void) {
      handlers[ev] = (handlers[ev] ?? []).filter((x) => x !== h);
      return proc;
    },
    stdout: { on() {} },
    stderr: { on() {} },
  };
  return { proc: proc as unknown as ChildProcess, killed: false };
}

const startTargetMock = vi.mocked(startTarget);
const startProxyMock = vi.mocked(startProxy);
const findFreePortMock = vi.mocked(findFreePort);
const prepareBeforeMock = vi.mocked(prepareBefore);
const cleanupBeforeMock = vi.mocked(cleanupBefore);

let root: string;
let portCounter: { p: number };
let createdProcs: FakeProc[];
let proxyPorts: number[];
let killSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "uim-state-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "uim-state-fixture",
      devDependencies: { vite: "^5.0.0" },
      scripts: { dev: "vite" },
    })
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  createdProcs = [];
  proxyPorts = [];
  portCounter = { p: 40000 };
  killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("mocked ESRCH");
  });

  findFreePortMock.mockImplementation(async (start: number) => {
    portCounter.p += 1;
    return start;
  });
  prepareBeforeMock.mockReturnValue({
    dir: root,
    mode: "none",
    root,
    worktreeAdded: false,
  });
  cleanupBeforeMock.mockImplementation(() => {});
  startTargetMock.mockReset();
  startProxyMock.mockReset();
});

afterEach(async () => {
  killSpy.mockRestore();
  await stopProject().catch(() => {});
});

describe("S3 — ライフサイクル直列化 (promise-chain mutex)", () => {
  beforeEach(() => {
    startTargetMock.mockImplementation(async () => {
      const f = makeFakeProc();
      createdProcs.push(f);
      return {
        proc: f.proc,
        plan: {
          framework: "Vite",
          command: "npx",
          args: ["vite"],
          knownPort: true,
        },
        port: 5180,
        logs: [],
      } as any;
    });
    startProxyMock.mockImplementation(async (_tp: number, pp: number) => {
      proxyPorts.push(pp);
      return { server: {}, port: pp, close: async () => {} } as any;
    });
  });

  it("openAndStart でセッションが起動する", async () => {
    const info = await openAndStart(root);
    expect(info.framework).toBe("Vite");
    expect(getRoot()).toBe(root);
    expect(info.beforeError).toBeNull();
    expect(startTargetMock).toHaveBeenCalledTimes(1);
  });

  it("2並行 startProject は直列化され target/proxy は単一セット(2本目は短絡)", async () => {
    await openProject(root);
    expect(startTargetMock).not.toHaveBeenCalled();

    const [r1, r2] = await Promise.all([startProject(), startProject()]);
    // after target の startTarget は1回だけ(2本目は short-circuit)
    expect(startTargetMock).toHaveBeenCalledTimes(1);
    // before+after プロキシで2回(単一セット)
    expect(startProxyMock).toHaveBeenCalledTimes(2);
    expect(new Set(proxyPorts).size).toBe(2);
    // 両結果は同一セッション
    expect(r1).toEqual(r2);

    // stop で全 target が停止(孤児なし)
    await stopProject();
    for (const f of createdProcs) expect(f.proc.exitCode).not.toBeNull();
  });
});

describe("S6 — before プレビュー起動失敗の可視化", () => {
  let beforeDir: string;

  beforeEach(() => {
    beforeDir = mkdtempSync(join(tmpdir(), "uim-before-"));
    prepareBeforeMock.mockReturnValue({
      dir: beforeDir,
      mode: "worktree",
      root,
      worktreeAdded: true,
      worktreeRoot: beforeDir,
    });
    startTargetMock.mockImplementation(async (dir: string) => {
      if (dir === beforeDir) throw new Error("boom: before port");
      const f = makeFakeProc();
      createdProcs.push(f);
      return {
        proc: f.proc,
        plan: {
          framework: "Vite",
          command: "npx",
          args: ["vite"],
          knownPort: true,
        },
        port: 5190,
        logs: [],
      } as any;
    });
    startProxyMock.mockImplementation(async (_tp: number, pp: number) => {
      proxyPorts.push(pp);
      return { server: {}, port: pp, close: async () => {} } as any;
    });
  });

  afterEach(() => {
    rmSync(beforeDir, { recursive: true, force: true });
  });

  it("before target 起動失敗時、beforeError に書き込み beforeProxyPort は null", async () => {
    const info = await openAndStart(root);
    expect(info.beforeError).toContain("編集前プレビュー起動失敗");
    expect(info.beforeError).toContain("boom: before port");
    expect(info.beforeProxyPort).toBeNull();
    expect(info.afterProxyPort).not.toBeNull();
    // after proxy のみ起動(before proxy は targetBefore null でスキップ)
    expect(startProxyMock).toHaveBeenCalledTimes(1);
  });
});