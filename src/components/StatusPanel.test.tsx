// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { StatusPanel } from "./StatusPanel";
import { api, type StatusResp } from "../lib/api";

vi.mock("../lib/api", () => ({
  api: { status: vi.fn() },
}));

const statusResp: StatusResp = {
  info: {
    root: "/demo",
    name: "demo",
    framework: "vite",
    runCommand: "npm run dev",
    running: true,
    beforeProxyPort: 5174,
    afterProxyPort: 5175,
    targetPortBefore: 5173,
    targetPortAfter: 5173,
    gitMode: "worktree",
  },
  hasKey: true,
  logs: [],
};

describe("StatusPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(api.status).mockResolvedValue(statusResp);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    cleanup();
  });

  /** 初回 fetch の Promise と microtask を flush して state 更新を完了させる(macrotask は進めない) */
  async function flushInitial() {
    await act(async () => {
      await Promise.resolve();
    });
  }

  it("APIキー有無 / framework / gitMode / 前後ポート / running を表示する", async () => {
    render(<StatusPanel />);
    await flushInitial();

    expect(screen.getByText("vite")).not.toBeNull();
    expect(screen.getByText("API key OK")).not.toBeNull();
    expect(screen.getByText(/git worktree/)).not.toBeNull();
    expect(screen.getByText(/5174/)).not.toBeNull();
    expect(screen.getByText(/5175/)).not.toBeNull();
    expect(screen.getByText(/running/)).not.toBeNull();
  });

  it("APIキー未設定時は「API key 未設定」を表示する", async () => {
    vi.mocked(api.status).mockResolvedValue({
      info: statusResp.info,
      hasKey: false,
      logs: [],
    });
    render(<StatusPanel />);
    await flushInitial();

    expect(screen.getByText("API key 未設定")).not.toBeNull();
  });

  it("ポーリングで 3秒ごとに api.status を再取得する", async () => {
    render(<StatusPanel />);
    await flushInitial();
    expect(api.status).toHaveBeenCalledTimes(1);

    // 3秒進める → 2回目
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.status).toHaveBeenCalledTimes(2);

    // さらに3秒 → 3回目
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(api.status).toHaveBeenCalledTimes(3);
  });
});
