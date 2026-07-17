// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Chat } from "./Chat";
import { api } from "../lib/api";
import type { DomDescriptor, EditProposal, ProjectInfo } from "../lib/types";

vi.mock("../lib/api", () => ({
  api: {
    status: vi.fn(),
    edit: vi.fn(),
    editStream: vi.fn(),
    editCandidate: vi.fn(),
    applyEdit: vi.fn(),
    rejectEdit: vi.fn(),
    undoEdit: vi.fn(),
    redoEdit: vi.fn(),
    editHistory: vi.fn(),
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

const otherDescriptor: DomDescriptor = {
  tag: "a",
  id: "link",
  classes: ["secondary"],
  attrs: {},
  textSnippet: "Other",
  domPath: "html>body>a",
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
    vi.mocked(api.status).mockReturnValue(new Promise<never>(() => {}));
  });
  afterEach(cleanup);

  it("ログ領域と入力欄にアクセシブル名/ライブリージョンを持つ", () => {
    render(<Chat selected={descriptor} hasKey={true} />);

    expect(screen.getByRole("textbox", { name: "編集指示" })).not.toBeNull();
    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect(log.getAttribute("aria-relevant")).toBe("additions");
  });

  it("指示送信 → api.editStream が EditProposal を返し DiffView に差分表示(まだ applyEdit は呼ばれない)", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");

    expect(api.editStream).toHaveBeenCalledWith(
      { descriptor, instruction: "赤くして" },
      expect.objectContaining({
        onStage: expect.any(Function),
        onProgress: expect.any(Function),
      })
    );
    expect(await screen.findByText("承認して適用")).not.toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("log").textContent).toContain(
        "差分の準備ができました。承認または却下してください。"
      )
    );
    expect(screen.getByText("+added line")).not.toBeNull();
    expect(screen.getByText("-removed line")).not.toBeNull();
    expect(api.applyEdit).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter 送信では textarea の既定改行を抑止して送信する", async () => {
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    render(<Chat selected={descriptor} hasKey={true} />);

    const textarea = screen.getByRole("textbox", {
      name: "編集指示",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "赤くして" } });
    const event = createEvent.keyDown(textarea, {
      key: "Enter",
      ctrlKey: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");

    fireEvent(textarea, event);

    expect(preventDefault).toHaveBeenCalled();
    await waitFor(() =>
      expect(api.editStream).toHaveBeenCalledWith(
        { descriptor, instruction: "赤くして" },
        expect.any(Object)
      )
    );
  });

  it("ストリームの進捗を表示し、result 到着後は従来どおり差分を表示する", async () => {
    const user = userEvent.setup();
    let resolveResult!: (proposal: EditProposal) => void;
    vi.mocked(api.editStream).mockImplementation((_body, handlers) => {
      handlers.onStage({ stage: "generating", file: "src/App.tsx" });
      handlers.onProgress({ chars: 42, tail: "const updated = true;" });
      return new Promise((resolve) => {
        resolveResult = resolve;
      });
    });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");

    expect(await screen.findByText("生成中: src/App.tsx (42文字)")).not.toBeNull();
    expect(screen.getByText("const updated = true;")).not.toBeNull();

    await act(async () => {
      resolveResult(goodProposal());
    });

    expect(await screen.findByRole("button", { name: "承認して適用" })).not.toBeNull();
    expect(screen.getByText("+added line")).not.toBeNull();
  });

  it("同じ選択の保留中提案へ続けて指示すると previousProposalId を送る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream)
      .mockResolvedValueOnce(goodProposal({ proposalId: "pending-1" }))
      .mockResolvedValueOnce(goodProposal({ proposalId: "pending-2" }));
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    expect(
      await screen.findByText(
        "続けて指示すると提案を追い込めます（例: もっと大きく）"
      )
    ).not.toBeNull();

    await sendInstruction(user, "もっと大きく");

    expect(api.editStream).toHaveBeenNthCalledWith(
      2,
      {
        descriptor,
        instruction: "もっと大きく",
        previousProposalId: "pending-1",
      },
      expect.any(Object)
    );
  });

  it.each([
    ["ok:false", () => Promise.resolve({ ok: false, error: "refinement failed" })],
    ["exception", () => Promise.reject(new Error("refinement failed"))],
  ])("追い込みが %s で失敗しても前の提案を復元する", async (_case, fail) => {
    const user = userEvent.setup();
    vi.mocked(api.editStream)
      .mockResolvedValueOnce(goodProposal({ proposalId: "pending-1" }))
      .mockImplementationOnce(() => fail() as Promise<EditProposal>);
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("+added line");
    await sendInstruction(user, "もっと大きく");

    expect(await screen.findByText(/refinement failed/)).not.toBeNull();
    expect(screen.getByText("+added line")).not.toBeNull();
    expect(
      screen.getByText('提案対象: <button #btn> "Click me"')
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "承認して適用" })).not.toBeNull();
  });

  it("Cmd+Enter で保留中の提案を適用する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({
      ok: true,
      relFile: "src/App.tsx",
    });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByRole("button", { name: "承認して適用" });
    fireEvent.keyDown(document, { key: "Enter", metaKey: true });

    await waitFor(() => expect(api.applyEdit).toHaveBeenCalledWith("p1"));
  });

  it("IME composition 中の Cmd+Enter では保留中の提案を適用しない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByRole("button", { name: "承認して適用" });
    fireEvent.keyDown(document, {
      key: "Enter",
      metaKey: true,
      isComposing: true,
    });

    expect(api.applyEdit).not.toHaveBeenCalled();
  });

  it("選択解除後の Cmd+Enter では保留中の提案を適用しない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    const { rerender } = render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByRole("button", { name: "承認して適用" });
    rerender(<Chat selected={null} hasKey={true} />);
    fireEvent.keyDown(document, { key: "Enter", metaKey: true });

    expect(api.applyEdit).not.toHaveBeenCalled();
  });

  it("承認クリックで api.applyEdit が呼ばれ、成功メッセージが出る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.status).mockResolvedValueOnce({
      info: null,
      hasKey: true,
      logs: [],
      undoDepth: 1,
      redoDepth: 2,
    });
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({
      ok: true,
      relFile: "src/App.tsx",
      undoDepth: 2,
    });
    render(<Chat selected={descriptor} hasKey={true} />);
    expect(
      await screen.findByRole("button", { name: /redo \(2\)/ })
    ).not.toBeNull();

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));

    expect(api.applyEdit).toHaveBeenCalledWith("p1");
    expect(await screen.findByText(/適用しました/)).not.toBeNull();
    expect(
      await screen.findByRole("button", { name: /undo \(2\)/ })
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: /redo/ })).toBeNull();
  });

  // ★最重要: apply 失敗時の回帰テスト(Codex確認済みの修正)
  it("api.applyEdit が ok:false を返したとき proposal を保持し再試行可能・busy解除される", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
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
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
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

  it("却下中は busy になり二重 reject を防ぐ", async () => {
    const user = userEvent.setup();
    let resolveReject!: () => void;
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    vi.mocked(api.rejectEdit).mockReturnValue(
      new Promise((resolve) => {
        resolveReject = () => resolve({ ok: true });
      })
    );
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    const rejectBtn = screen.getByRole("button", {
      name: "却下",
    }) as HTMLButtonElement;

    await user.click(rejectBtn);

    expect(api.rejectEdit).toHaveBeenCalledWith("p1");
    expect(screen.getByText("処理中…")).not.toBeNull();
    expect(rejectBtn.disabled).toBe(true);

    await user.click(rejectBtn);

    expect(api.rejectEdit).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveReject();
    });

    expect(await screen.findByText("提案を却下しました")).not.toBeNull();
    expect(screen.queryByText("処理中…")).toBeNull();
  });

  it("confidence=low/candidates ありのとき Candidates が表示され、選択で api.editCandidate が呼ばれる", async () => {
    const user = userEvent.setup();
    const candidate = { file: "src/App.tsx", line: 10, preview: "const x = 1" };
    vi.mocked(api.editStream).mockResolvedValue({
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
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({
      ok: true,
      relFile: "src/App.tsx",
      undoDepth: 2,
    });
    vi.mocked(api.undoEdit).mockResolvedValue({
      ok: true,
      relFile: "src/App.tsx",
      undoDepth: 1,
      redoDepth: 1,
    });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    // 適用成功 → undoDepth>0 → undo ボタン表示
    const undoBtn = await screen.findByRole("button", { name: /undo \(2\)/ });
    await user.click(undoBtn);

    expect(api.undoEdit).toHaveBeenCalled();
    expect(await screen.findByText(/元に戻しました/)).not.toBeNull();
    expect(await screen.findByRole("button", { name: /undo \(1\)/ })).not.toBeNull();
    expect(await screen.findByRole("button", { name: /redo \(1\)/ })).not.toBeNull();
  });

  it("redo ボタンクリックで api.redoEdit を呼び、サーバの深さを反映する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.status).mockResolvedValueOnce({
      info: null,
      hasKey: true,
      logs: [],
      undoDepth: 1,
      redoDepth: 2,
    });
    vi.mocked(api.redoEdit).mockResolvedValue({
      ok: true,
      relFile: "src/App.tsx",
      undoDepth: 2,
      redoDepth: 1,
    });
    render(<Chat selected={descriptor} hasKey={true} />);

    const redoBtn = await screen.findByRole("button", { name: /redo \(2\)/ });
    await user.click(redoBtn);

    expect(api.redoEdit).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/やり直しました/)).not.toBeNull();
    expect(await screen.findByRole("button", { name: /undo \(2\)/ })).not.toBeNull();
    expect(await screen.findByRole("button", { name: /redo \(1\)/ })).not.toBeNull();
  });

  it("api.undoEdit が ok:false を返したとき status を再取得して undoDepth を更新する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({
      ok: true,
      relFile: "src/App.tsx",
      undoDepth: 1,
    });
    vi.mocked(api.undoEdit).mockResolvedValue({ ok: false, error: "undo失敗" });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    const undoBtn = (await screen.findByRole("button", { name: /undo/ })) as HTMLButtonElement;
    vi.mocked(api.status).mockResolvedValueOnce({
      info: null,
      hasKey: true,
      logs: [],
      undoDepth: 2,
    });
    await user.click(undoBtn);

    expect(await screen.findByText(/undo失敗/)).not.toBeNull();
    expect(
      await screen.findByRole("button", { name: /undo \(2\)/ })
    ).not.toBeNull();
    expect(screen.queryByText("処理中…")).toBeNull();
  });

  it("api.undoEdit と status 再取得が失敗したとき undoDepth を維持する", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    vi.mocked(api.applyEdit).mockResolvedValue({ ok: true, relFile: "src/App.tsx" });
    vi.mocked(api.undoEdit).mockRejectedValue(new Error("network down"));
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");
    await screen.findByText("承認して適用");
    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    const undoBtn = (await screen.findByRole("button", { name: /undo/ })) as HTMLButtonElement;
    vi.mocked(api.status).mockRejectedValueOnce(new Error("status down"));
    await user.click(undoBtn);

    expect(await screen.findByText(/network down/)).not.toBeNull();
    expect(
      await screen.findByRole("button", { name: /undo \(1\)/ })
    ).not.toBeNull();
    expect(consoleError).toHaveBeenCalled();
    expect(screen.queryByText("処理中…")).toBeNull();
    consoleError.mockRestore();
  });

  it("mount 時に api.status から undoDepth を取得して undo ボタンを表示する", async () => {
    vi.mocked(api.status).mockResolvedValueOnce({
      info: null,
      hasKey: true,
      logs: [],
      undoDepth: 3,
    });
    render(<Chat selected={descriptor} hasKey={true} />);

    expect(
      await screen.findByRole("button", { name: /undo \(3\)/ })
    ).not.toBeNull();
  });

  it("project key が変わると新しい project の undoDepth を再取得する", async () => {
    vi.mocked(api.status)
      .mockResolvedValueOnce({
        info: null,
        hasKey: true,
        logs: [],
        undoDepth: 3,
      })
      .mockResolvedValueOnce({
        info: null,
        hasKey: true,
        logs: [],
        undoDepth: 1,
      });
    const { rerender } = render(
      <Chat key="/demo" selected={descriptor} hasKey={true} />
    );

    expect(
      await screen.findByRole("button", { name: /undo \(3\)/ })
    ).not.toBeNull();

    rerender(<Chat key="/other" selected={descriptor} hasKey={true} />);

    expect(
      await screen.findByRole("button", { name: /undo \(1\)/ })
    ).not.toBeNull();
    expect(api.status).toHaveBeenCalledTimes(2);
  });

  it("提案生成の hard failure では入力した指示文を復元する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue({
      ok: false,
      error: "boom",
    });
    render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "この文を保持");

    expect(await screen.findByText(/boom/)).not.toBeNull();
    expect(
      (screen.getByRole("textbox", { name: "編集指示" }) as HTMLTextAreaElement)
        .value
    ).toBe("この文を保持");
  });

  it("選択要素が変わっても保留中提案は生成時 descriptor を参照し、不一致ヒントを表示する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    const { rerender } = render(<Chat selected={descriptor} hasKey={true} />);

    await sendInstruction(user, "赤くして");

    expect(
      await screen.findByText("提案対象: <button #btn> \"Click me\"")
    ).not.toBeNull();
    rerender(<Chat selected={otherDescriptor} hasKey={true} />);

    expect(
      screen.getByText("提案対象: <button #btn> \"Click me\"")
    ).not.toBeNull();
    expect(screen.getByText("この差分は別の選択要素のものです")).not.toBeNull();
    expect(screen.getByText("+added line")).not.toBeNull();
  });

  it("project key が変わると保留中の提案 state が remount で消える", async () => {
    const user = userEvent.setup();
    vi.mocked(api.editStream).mockResolvedValue(goodProposal());
    const { rerender } = render(
      <Chat key="/demo" selected={descriptor} hasKey={true} />
    );

    await sendInstruction(user, "赤くして");
    expect(await screen.findByText("+added line")).not.toBeNull();
    expect(
      screen.getByText("提案対象: <button #btn> \"Click me\"")
    ).not.toBeNull();

    rerender(<Chat key="/other" selected={otherDescriptor} hasKey={true} />);

    expect(screen.queryByText("+added line")).toBeNull();
    expect(screen.queryByText("提案対象: <button #btn> \"Click me\"")).toBeNull();
    expect(screen.queryByRole("button", { name: "承認して適用" })).toBeNull();
  });
});

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.doUnmock("../lib/api.ts");
    vi.doUnmock("./ProjectBar.tsx");
    vi.doUnmock("./BeforePreview.tsx");
    vi.doUnmock("./AfterPreview.tsx");
    vi.doUnmock("./Chat.tsx");
    vi.doUnmock("./StatusPanel.tsx");
  });

  it("初回 status が一度失敗しても短いバックオフ後に再取得して両プレビューへ info を渡す", async () => {
    const info: ProjectInfo = {
      root: "/tmp/retry-project",
      name: "Retry Project",
      framework: "vite",
      runCommand: "npm run dev",
      running: true,
      beforeProxyPort: 3101,
      afterProxyPort: 3102,
      targetPortBefore: 5173,
      targetPortAfter: 5174,
      gitMode: "worktree",
    };
    const status = vi.mocked(api.status);
    status
      .mockReset()
      .mockRejectedValueOnce(new Error("temporary status failure"))
      .mockResolvedValue({
        info,
        hasKey: true,
        logs: [],
        undoDepth: 0,
      });

    vi.doMock("./ProjectBar.tsx", () => ({
      ProjectBar: ({
        info,
        hasKey,
      }: {
        info: ProjectInfo | null;
        hasKey: boolean;
      }) => (
        <div data-testid="project-bar">
          {info?.name ?? "none"}:{hasKey ? "key" : "no-key"}
        </div>
      ),
    }));
    vi.doMock("./BeforePreview.tsx", () => ({
      BeforePreview: ({ info }: { info: ProjectInfo | null }) => (
        <div data-testid="before-preview">before:{info?.name ?? "none"}</div>
      ),
    }));
    vi.doMock("./AfterPreview.tsx", () => ({
      AfterPreview: ({ info }: { info: ProjectInfo | null }) => (
        <div data-testid="after-preview">after:{info?.name ?? "none"}</div>
      ),
    }));
    vi.doMock("./Chat.tsx", () => ({
      Chat: () => <div data-testid="chat" />,
    }));
    vi.doMock("./StatusPanel.tsx", () => ({
      StatusPanel: () => <div data-testid="status-panel" />,
    }));

    const { App } = await import("../App");
    vi.useFakeTimers();
    render(<App />);

    expect(status).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("before-preview").textContent).toBe("before:none");
    expect(screen.getByTestId("after-preview").textContent).toBe("after:none");

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("before:Retry Project")).not.toBeNull();
    expect(screen.getByText("after:Retry Project")).not.toBeNull();
    expect(screen.getByTestId("project-bar").textContent).toBe("Retry Project:key");
    expect(screen.queryByText(/temporary status failure/)).toBeNull();
    expect(status).toHaveBeenCalledTimes(2);
  });
});
