// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { HistoryPanel } from "./HistoryPanel";

vi.mock("../lib/api", () => ({
  api: { editHistory: vi.fn() },
}));

describe("HistoryPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(cleanup);

  function openPanel() {
    const details = screen.getByText("編集履歴").closest("details") as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event("toggle"));
  }

  it("開いたときに履歴を取得し、ファイル名・概要・時刻を表示する", async () => {
    vi.mocked(api.editHistory).mockResolvedValue({
      history: [
        {
          id: "h1",
          relFile: "src/components/Chat.tsx",
          summary: "src/components/Chat.tsx を適用しました。",
          instruction: "ボタンを青くして",
          appliedAt: "2026-07-17T03:34:00.000Z",
          kind: "apply",
        },
      ],
    });
    render(<HistoryPanel />);

    openPanel();

    await waitFor(() => expect(api.editHistory).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Chat.tsx")).not.toBeNull();
    expect(screen.getByText("src/components/Chat.tsx を適用しました。")).not.toBeNull();
    expect(screen.getByText(/^\d{2}:\d{2}$/)).not.toBeNull();
  });

  it("履歴が空なら案内文を表示する", async () => {
    vi.mocked(api.editHistory).mockResolvedValue({ history: [] });
    render(<HistoryPanel />);

    openPanel();

    await waitFor(() => expect(api.editHistory).toHaveBeenCalledTimes(1));
    expect(screen.getByText("まだ編集はありません")).not.toBeNull();
  });
});
