// S4: クラッシュ安全シャットダウンのスモークテスト。
// uncaughtException ハンドラ経由で stopProject が呼ばれることを検証(stopProject はモック)。
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stopProject: vi.fn(async () => {}),
  killAllChildrenSync: vi.fn(),
  cleanupAllBefore: vi.fn(),
  sweepStaleBeforeDirs: vi.fn(),
}));

vi.mock("./lib/state.ts", () => ({ stopProject: mocks.stopProject }));
vi.mock("./lib/runner.ts", () => ({
  killAllChildrenSync: mocks.killAllChildrenSync,
}));
vi.mock("./lib/worktree.ts", () => ({
  cleanupAllBefore: mocks.cleanupAllBefore,
  sweepStaleBeforeDirs: mocks.sweepStaleBeforeDirs,
}));
vi.mock("./routes/api.ts", async () => {
  const { Hono } = await import("hono");
  return { api: new Hono() } as unknown as typeof import("./routes/api.ts");
});
vi.mock("./middleware/security.ts", () => ({
  securityMiddleware: async (_c: unknown, next: () => Promise<void>) =>
    await next(),
}));
vi.mock("@hono/node-server", () => ({
  serve: () => ({
    close() {},
    on() {},
  }),
}));

describe("S4 — クラッシュ安全シャットダウン", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    mocks.stopProject.mockClear();
    mocks.killAllChildrenSync.mockClear();
    mocks.cleanupAllBefore.mockClear();
    mocks.sweepStaleBeforeDirs.mockClear();
  });

  it("registers startup GC and SIGHUP, and uncaughtException cleanup exits with code 1", async () => {
    const exitStub = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    // index.ts の process.on 登録を捕捉しつつ実際には登録しない(直接呼ぶので)。
    const added: Array<[string, (...a: unknown[]) => void]> = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((
        ev: string,
        h: (...a: unknown[]) => void
      ) => {
        added.push([ev, h]);
        return process;
      }) as never);

    await import("./index.ts");

    onSpy.mockRestore();

    expect(mocks.sweepStaleBeforeDirs).toHaveBeenCalledTimes(1);
    expect(added.some(([ev]) => ev === "SIGHUP")).toBe(true);

    const uncaught = added.find(([ev]) => ev === "uncaughtException")?.[1];
    expect(uncaught).toBeTruthy();

    // ハンドラを直接呼び出し、プロセス全体へ伝搬させない。
    await uncaught!(new Error("boom-from-test") as unknown as undefined);

    expect(mocks.stopProject).toHaveBeenCalledTimes(1);
    // gracefulExit は非同期(stopProject await → finally)なので少し待つ
    await vi.waitFor(() => expect(exitStub).toHaveBeenCalledWith(1));
    expect(mocks.killAllChildrenSync).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupAllBefore).toHaveBeenCalledTimes(1);

    exitStub.mockRestore();
  }, 15_000);

  it("hardKill timeout kills children and cleans before handles while stopProject is stuck", async () => {
    vi.useFakeTimers();
    mocks.stopProject.mockImplementationOnce(() => new Promise(() => {}));
    const exitStub = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);

    const added: Array<[string, (...a: unknown[]) => void]> = [];
    const onSpy = vi
      .spyOn(process, "on")
      .mockImplementation(((
        ev: string,
        h: (...a: unknown[]) => void
      ) => {
        added.push([ev, h]);
        return process;
      }) as never);

    await import("./index.ts");
    onSpy.mockRestore();

    const sigterm = added.find(([ev]) => ev === "SIGTERM")?.[1];
    expect(sigterm).toBeTruthy();
    sigterm!();

    await vi.advanceTimersByTimeAsync(6_000);

    expect(mocks.killAllChildrenSync).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupAllBefore).toHaveBeenCalledTimes(1);
    expect(exitStub).toHaveBeenCalledWith(0);

    exitStub.mockRestore();
    vi.useRealTimers();
  });
});
