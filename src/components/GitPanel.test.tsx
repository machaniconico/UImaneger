// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitPanel } from "./GitPanel";
import { api } from "../lib/api";
import type { ProjectInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    gitStatus: vi.fn(),
    gitCommit: vi.fn(),
  },
  getErrorMessage: (error: unknown) =>
    error instanceof Error && error.message ? error.message : String(error),
}));

const info: ProjectInfo = {
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("GitPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.gitStatus).mockResolvedValue({ changes: [] });
    vi.mocked(api.gitCommit).mockResolvedValue({ ok: true });
  });

  afterEach(cleanup);

  it("does not call git status before a project is open", () => {
    render(<GitPanel info={null} />);

    expect(screen.getByText("プロジェクト未オープン")).not.toBeNull();
    expect(api.gitStatus).not.toHaveBeenCalled();
  });

  it("shows git status changes in a compact list", async () => {
    vi.mocked(api.gitStatus).mockResolvedValue({
      changes: [" M src/App.tsx", "?? src/components/GitPanel.tsx"],
    });

    render(<GitPanel info={info} />);

    expect(await screen.findByText("2 changes")).not.toBeNull();
    expect(screen.getByText("src/App.tsx")).not.toBeNull();
    expect(screen.getByText("src/components/GitPanel.tsx")).not.toBeNull();
  });

  it("requires a message and commits changes, then refreshes status", async () => {
    const user = userEvent.setup();
    vi.mocked(api.gitStatus)
      .mockResolvedValueOnce({ changes: [" M src/App.tsx"] })
      .mockResolvedValueOnce({ changes: [] });

    render(<GitPanel info={info} />);

    await screen.findByText("1 changes");
    const commitButton = screen.getByRole("button", { name: "Commit" });
    expect(commitButton).toHaveProperty("disabled", true);

    await user.type(screen.getByLabelText("Commit message"), "Apply UI edit");
    expect(commitButton).toHaveProperty("disabled", false);
    await user.click(commitButton);

    expect(api.gitCommit).toHaveBeenCalledWith("Apply UI edit");
    expect(await screen.findByText("コミットしました")).not.toBeNull();
    await waitFor(() => expect(api.gitStatus).toHaveBeenCalledTimes(2));
    expect(screen.getByText("変更なし")).not.toBeNull();
    expect(screen.getByLabelText("Commit message")).toHaveProperty("value", "");
  });

  it("keeps the message and shows an inline error when commit fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.gitStatus).mockResolvedValue({ changes: [" M src/App.tsx"] });
    vi.mocked(api.gitCommit).mockRejectedValue(
      new Error("コミットする変更がありません")
    );

    render(<GitPanel info={info} />);

    await screen.findByText("1 changes");
    await user.type(screen.getByLabelText("Commit message"), "No changes");
    await user.click(screen.getByRole("button", { name: "Commit" }));

    expect(await screen.findByText("コミットする変更がありません")).not.toBeNull();
    expect(screen.getByLabelText("Commit message")).toHaveProperty(
      "value",
      "No changes"
    );
  });

  it("refreshes git status after an edit is applied", async () => {
    vi.mocked(api.gitStatus)
      .mockResolvedValueOnce({ changes: [] })
      .mockResolvedValueOnce({ changes: [" M src/App.tsx"] });

    render(<GitPanel info={info} />);

    await screen.findByText("変更なし");
    fireEvent(window, new Event("uim:applied"));

    expect(await screen.findByText("1 changes")).not.toBeNull();
    expect(api.gitStatus).toHaveBeenCalledTimes(2);
  });

  it("ignores stale git status responses after the project changes", async () => {
    const first = deferred<{ changes: string[] }>();
    vi.mocked(api.gitStatus)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ changes: [" M src/NewApp.tsx"] });
    const { rerender } = render(<GitPanel info={info} />);

    rerender(
      <GitPanel
        info={{
          ...info,
          root: "/other",
          name: "other",
        }}
      />
    );

    expect(await screen.findByText("src/NewApp.tsx")).not.toBeNull();
    await act(async () => {
      first.resolve({ changes: [" M src/OldApp.tsx"] });
    });

    expect(screen.queryByText("src/OldApp.tsx")).toBeNull();
    expect(screen.getByText("src/NewApp.tsx")).not.toBeNull();
  });

  it("エラー表示は role=alert で読み上げられる", async () => {
    vi.mocked(api.gitStatus).mockRejectedValue(new Error("git が失敗しました"));

    render(<GitPanel info={info} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("git が失敗しました");
  });
});
