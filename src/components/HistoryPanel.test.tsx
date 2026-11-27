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
    render(<HistoryPanel root="/a" />);

    openPanel();

    await waitFor(() => expect(api.editHistory).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Chat.tsx")).not.toBeNull();
    expect(screen.getByText("src/components/Chat.tsx を適用しました。")).not.toBeNull();
    expect(screen.getByText(/^\d{2}:\d{2}$/)).not.toBeNull();
  });

  it("履歴が空なら案内文を表示する", async () => {
    vi.mocked(api.editHistory).mockResolvedValue({ history: [] });
    render(<HistoryPanel root="/a" />);

    openPanel();

    await waitFor(() => expect(api.editHistory).toHaveBeenCalledTimes(1));
    expect(screen.getByText("まだ編集はありません")).not.toBeNull();
  });

  const entry = (id: string, relFile: string) => ({
    id,
    relFile,
    summary: `${relFile} を適用しました。`,
    instruction: "x",
    appliedAt: "2026-07-17T03:34:00.000Z",
    kind: "apply" as const,
  });

  it("プロジェクト(root)が変わったら前の履歴をクリアして再取得する", async () => {
    vi.mocked(api.editHistory).mockResolvedValueOnce({ history: [entry("h1", "src/A.tsx")] });
    const { rerender } = render(<HistoryPanel root="/a" />);
    openPanel();
    expect(await screen.findByText("A.tsx")).not.toBeNull();

    let resolveB!: (v: { history: ReturnType<typeof entry>[] }) => void;
    vi.mocked(api.editHistory).mockReturnValueOnce(
      new Promise((r) => {
        resolveB = r;
      })
    );
    rerender(<HistoryPanel root="/b" />);

    expect(screen.queryByText("A.tsx")).toBeNull();
    resolveB({ history: [entry("h2", "src/B.tsx")] });
    expect(await screen.findByText("B.tsx")).not.toBeNull();
    expect(screen.queryByText("A.tsx")).toBeNull();
  });

  it("切替前リクエストの遅れた応答で前プロジェクトの履歴を表示しない", async () => {
    let resolveA!: (v: { history: ReturnType<typeof entry>[] }) => void;
    vi.mocked(api.editHistory).mockReturnValueOnce(
      new Promise((r) => {
        resolveA = r;
      })
    );
    const { rerender } = render(<HistoryPanel root="/a" />);
    openPanel();
    vi.mocked(api.editHistory).mockResolvedValueOnce({ history: [entry("h2", "src/B.tsx")] });
    rerender(<HistoryPanel root="/b" />);
    expect(await screen.findByText("B.tsx")).not.toBeNull();

    resolveA({ history: [entry("h1", "src/A.tsx")] });
    await Promise.resolve();
    expect(screen.queryByText("A.tsx")).toBeNull();
  });

  it("取得失敗時は古い履歴を出さず「サーバに接続できません」を表示し、再取得で戻る", async () => {
    vi.mocked(api.editHistory).mockResolvedValueOnce({ history: [entry("h1", "src/A.tsx")] });
    render(<HistoryPanel root="/a" />);
    openPanel();
    expect(await screen.findByText("A.tsx")).not.toBeNull();

    vi.mocked(api.editHistory).mockRejectedValueOnce(new Error("Failed to fetch"));
    window.dispatchEvent(new Event("uim:applied"));
    expect((await screen.findByRole("alert")).textContent).toContain("サーバに接続できません");
    expect(screen.queryByText("A.tsx")).toBeNull();

    vi.mocked(api.editHistory).mockResolvedValueOnce({ history: [entry("h3", "src/C.tsx")] });
    window.dispatchEvent(new Event("uim:applied"));
    expect(await screen.findByText("C.tsx")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("アイコンに読み上げ名(適用 / 元に戻す / やり直し)を持つ", async () => {
    vi.mocked(api.editHistory).mockResolvedValue({
      history: [
        { ...entry("h1", "src/A.tsx"), kind: "apply" },
        { ...entry("h2", "src/B.tsx"), kind: "undo" },
        { ...entry("h3", "src/C.tsx"), kind: "redo" },
      ],
    });
    render(<HistoryPanel root="/a" />);
    openPanel();
    await screen.findByText("A.tsx");

    expect(screen.getByRole("img", { name: "適用" })).not.toBeNull();
    expect(screen.getByRole("img", { name: "元に戻す" })).not.toBeNull();
    expect(screen.getByRole("img", { name: "やり直し" })).not.toBeNull();
  });
});
