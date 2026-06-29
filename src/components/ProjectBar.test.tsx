// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectBar } from "./ProjectBar";
import { api } from "../lib/api";
import type { ProjectInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: { open: vi.fn(), clone: vi.fn(), stop: vi.fn() },
}));

const runningInfo: ProjectInfo = {
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
};

function setup(overrides: Record<string, unknown> = {}) {
  const props = {
    info: runningInfo,
    hasKey: true,
    busy: false,
    setBusy: vi.fn(),
    onInfo: vi.fn(),
    onError: vi.fn(),
    selectMode: false,
    setSelectMode: vi.fn(),
    ...overrides,
  };
  render(<ProjectBar {...(props as any)} />);
  return props;
}

describe("ProjectBar.stop()", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it("停止成功時: onInfo が呼ばれ onError がクリアされ busy が解除される", async () => {
    const user = userEvent.setup();
    vi.mocked(api.stop).mockResolvedValue({ info: null });
    const props = setup();

    await user.click(screen.getByRole("button", { name: "停止" }));

    expect(api.stop).toHaveBeenCalled();
    await waitFor(() => expect(props.onInfo).toHaveBeenCalledWith(null));
    expect(props.onError).toHaveBeenCalledWith(""); // 開始時クリア
    expect(props.setBusy).toHaveBeenCalledWith(true);
    // finally で必ず false に戻す
    await waitFor(() => expect(props.setBusy).toHaveBeenLastCalledWith(false));
  });

  // R4 で追加した catch 経路の回帰テスト
  it("停止失敗時(reject): onError にメッセージが渡り busy が解除される(UIが固まらない)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.stop).mockRejectedValue(new Error("stop boom"));
    const props = setup();

    await user.click(screen.getByRole("button", { name: "停止" }));

    await waitFor(() =>
      expect(props.onError).toHaveBeenCalledWith(expect.stringContaining("stop boom"))
    );
    // finally で busy 解除(永久固まり防止)
    await waitFor(() => expect(props.setBusy).toHaveBeenLastCalledWith(false));
  });
});
