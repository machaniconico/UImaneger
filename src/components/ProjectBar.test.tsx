// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectBar } from "./ProjectBar";
import { api } from "../lib/api";
import type { ProjectInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: { open: vi.fn(), clone: vi.fn(), stop: vi.fn(), status: vi.fn() },
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

const stoppedInfo: ProjectInfo = {
  ...runningInfo,
  root: "/failed-target",
  name: "failed-target",
  running: false,
  beforeProxyPort: null,
  afterProxyPort: null,
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
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("パス入力にアクセシブル名を持つ", () => {
    setup();

    expect(
      screen.getByRole("textbox", { name: "ローカルパスまたはGitHub URL" })
    ).not.toBeNull();
  });

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

  it("open が res.error を返したら status を再取得して onInfo に反映する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.open).mockResolvedValue({ error: "起動失敗" });
    vi.mocked(api.status).mockResolvedValue({
      info: stoppedInfo,
      hasKey: true,
      logs: [],
    });
    const props = setup();

    await user.type(
      screen.getByRole("textbox", { name: "ローカルパスまたはGitHub URL" }),
      "/bad/project"
    );
    await user.click(screen.getByRole("button", { name: "開く" }));

    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith("起動失敗");
    expect(props.onInfo).toHaveBeenCalledWith(stoppedInfo);
    await waitFor(() => expect(props.setBusy).toHaveBeenLastCalledWith(false));
  });

  it("clone が reject したら status を再取得して onInfo に反映する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.clone).mockRejectedValue(new Error("clone boom"));
    vi.mocked(api.status).mockResolvedValue({
      info: stoppedInfo,
      hasKey: true,
      logs: [],
    });
    const props = setup();

    await user.type(
      screen.getByRole("textbox", { name: "ローカルパスまたはGitHub URL" }),
      "https://github.com/example/repo.git"
    );
    await user.click(screen.getByRole("button", { name: "Clone & 起動" }));

    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(props.onError).toHaveBeenCalledWith(
      expect.stringContaining("clone boom")
    );
    expect(props.onInfo).toHaveBeenCalledWith(stoppedInfo);
    await waitFor(() => expect(props.setBusy).toHaveBeenLastCalledWith(false));
  });

  it("HTTP エラー時はサーバーの JP error を HTTP prefix なしで表示する", async () => {
    const originalFetch = globalThis.fetch;
    const { api: realApi } = await vi.importActual<typeof import("../lib/api")>(
      "../lib/api"
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "指定されたパスを開けませんでした" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        })
      )
    );

    let message = "";
    try {
      await realApi.status();
    } catch (e: any) {
      message = String(e?.message || e);
    }

    expect(message).toBe("指定されたパスを開けませんでした");
    expect(message).not.toContain("HTTP 400:");
    if (originalFetch) vi.stubGlobal("fetch", originalFetch);
  });
});
