// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "./Chat";
import { api } from "../lib/api";
import type { DomDescriptor, EditProposal } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    edit: vi.fn(),
    editCandidate: vi.fn(),
    applyEdit: vi.fn(),
    rejectEdit: vi.fn(),
    undoEdit: vi.fn(),
  },
}));

const descriptor: DomDescriptor = {
  tag: "button",
  id: "btn",
  classes: ["primary"],
  attrs: {},
  textSnippet: "Click me",
  domPath: "html>body>button",
};

function goodProposal(overrides: Partial<EditProposal> = {}): EditProposal {
  return {
    ok: true,
    proposalId: "p1",
    diff: "+added line\n-removed line",
    relFile: "src/App.tsx",
    confidence: "high",
    ...overrides,
  };
}

async function sendInstruction(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.type(screen.getByPlaceholderText(/例:/), text);
  await user.click(screen.getByRole("button", { name: /差分を生成/ }));
}

describe("Chat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it("指示送信 → api.edit が EditProposal を返し DiffView に差分表示(まだ applyEdit は呼ばれない)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");

    expect(api.edit).toHaveBeenCalledWith(descriptor, "赤くして");
    expect(await screen.findByText("承認して適用")).not.toBeNull();
    expect(screen.getByText("+added line")).not.toBeNull();
    expect(screen.getByText("-removed line")).not.toBeNull();
    expect(api.applyEdit).not.toHaveBeenCalled();
  });

  it("承認クリックで api.applyEdit が呼ばれ、成功メッセージが出る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({ ok: true, relFile: "src/App.tsx" });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));

    expect(api.applyEdit).toHaveBeenCalledWith("p1");
    expect(await screen.findByText(/適用しました/)).not.toBeNull();
  });

  // ★最重要: apply 失敗時の回帰テスト(Codex確認済みの修正)
  it("api.applyEdit が ok:false を返したとき proposal を保持し再試行可能・busy解除される", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({ ok: false, error: "boom" });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));

    expect(api.applyEdit).toHaveBeenCalledWith("p1");
    // エラーメッセージが表示される
    expect(await screen.findByText(/boom/)).not.toBeNull();
    // proposal 保持 → 承認ボタンがまだ表示されている
    const applyBtn = screen.getByRole("button", { name: "承認して適用" }) as HTMLButtonElement;
    // busy 解除を待つ
    await waitFor(() => expect(applyBtn.disabled).toBe(false));
    // 「処理中…」が消えている
    expect(screen.queryByText("処理中…")).toBeNull();
    // 再試行可能
    await user.click(applyBtn);
    expect(api.applyEdit).toHaveBeenCalledTimes(2);
  });

  it("api.applyEdit が例外を投げたときも proposal 保持・busy解除される", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockRejectedValue(new Error("network down"));
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));

    expect(await screen.findByText(/network down/)).not.toBeNull();
    const applyBtn = screen.getByRole("button", { name: "承認して適用" }) as HTMLButtonElement;
    await waitFor(() => expect(applyBtn.disabled).toBe(false));
    expect(screen.queryByText("処理中…")).toBeNull();
  });

  it("confidence=low/candidates ありのとき Candidates が表示され、選択で api.editCandidate が呼ばれる", async () => {
    const user = userEvent.setup();
    const candidate = { file: "src/App.tsx", line: 10, preview: "const x = 1" };
    vi.mocked(api.edit).mockResolvedValue({
      ok: false,
      candidates: [candidate],
    });
    vi.mocked(api.editCandidate).mockResolvedValue(goodProposal({ proposalId: "p2" }));
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");

    // Candidates 表示
    expect(await screen.findByText("const x = 1")).not.toBeNull();
    // 候補クリック
    await user.click(screen.getByRole("button", { name: /const x = 1/ }));

    expect(api.editCandidate).toHaveBeenCalledWith(candidate, descriptor, "赤くして");
  });

  it("undo ボタンで api.undoEdit が呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({ ok: true, relFile: "src/App.tsx" });
    vi.mocked(api.undoEdit).mockResolvedValue({ ok: true, relFile: "src/App.tsx" });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    // 適用成功 → canUndo=true → undo ボタン表示
    const undoBtn = await screen.findByRole("button", { name: /undo/ });
    await user.click(undoBtn);

    expect(api.undoEdit).toHaveBeenCalled();
    expect(await screen.findByText(/元に戻しました/)).not.toBeNull();
  });

  // undo 失敗の回帰テスト(R4で catch を追加。apply 側と対称にカバー)
  it("api.undoEdit が ok:false を返したときエラー表示し undo ボタンが再び押せる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({ ok: true, relFile: "src/App.tsx" });
    vi.mocked(api.undoEdit).mockResolvedValue({ ok: false, error: "undo失敗" });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    const undoBtn = (await screen.findByRole("button", { name: /undo/ })) as HTMLButtonElement;
    await user.click(undoBtn);

    expect(await screen.findByText(/undo失敗/)).not.toBeNull();
    await waitFor(() => expect(undoBtn.disabled).toBe(false));
    expect(screen.queryByText("処理中…")).toBeNull();
  });

  it("api.undoEdit が例外を投げたときエラー表示し busy 解除される", async () => {
    const user = userEvent.setup();
    vi.mocked(api.edit).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({ ok: true, relFile: "src/App.tsx" });
    vi.mocked(api.undoEdit).mockRejectedValue(new Error("network down"));
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    const undoBtn = (await screen.findByRole("button", { name: /undo/ })) as HTMLButtonElement;
    await user.click(undoBtn);

    expect(await screen.findByText(/network down/)).not.toBeNull();
    await waitFor(() => expect(undoBtn.disabled).toBe(false));
  });
});
