// S4: クラッシュ安全シャットダウンのスモークテスト。
// uncaughtException ハンドラ経由で stopProject が呼ばれることを検証(stopProject はモック)。
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  stopProject: vi.fn(async () => {}),
}));

vi.mock("./lib/state.ts", () => ({ stopProject: mocks.stopProject }));
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
    mocks.stopProject.mockClear();
  });

  it("uncaughtException 発火で gracefulExit(1) が stopProject を呼ぶ", async () => {
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

    const uncaught = added.find(([ev]) => ev === "uncaughtException")?.[1];
    expect(uncaught).toBeTruthy();

    // ハンドラを直接呼び出し、プロセス全体へ伝搬させない。
    await uncaught!(new Error("boom-from-test") as unknown as undefined);

    expect(mocks.stopProject).toHaveBeenCalledTimes(1);
    // gracefulExit は非同期(stopProject await → finally)なので少し待つ
    await vi.waitFor(() => expect(exitStub).toHaveBeenCalledWith(1));

    exitStub.mockRestore();
  }, 15_000);
});