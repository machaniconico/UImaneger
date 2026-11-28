// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BeforePreview } from "./BeforePreview";
import { LOAD_TIMEOUT_MS } from "./AfterPreview";
import type { ProjectInfo } from "../lib/types";

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

describe("BeforePreview", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("iframe の load まで起動中 overlay を表示する", () => {
    render(
      <BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />
    );

    expect(screen.getByRole("status").textContent).toContain("起動中...");
    fireEvent.load(screen.getByTitle("編集前プレビュー"));
    expect(screen.queryByText("起動中...")).toBeNull();
  });

  it("running=false の通常停止なら neutral overlay を表示する", () => {
    render(
      <BeforePreview
        info={{
          ...runningInfo,
          running: false,
          beforeProxyPort: null,
          beforeError: null,
        }}
        selectMode={false}
        onSelect={() => {}}
      />
    );

    expect(screen.getByRole("status").textContent).toContain(
      "停止中です。「開く」で再表示します。"
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("beforeError がある場合は error tone でサーバー文字列をそのまま表示する", () => {
    const beforeError = "編集前プレビュー起動失敗: npm run dev failed";

    render(
      <BeforePreview
        info={{
          ...runningInfo,
          beforeProxyPort: null,
          beforeError,
        }}
        selectMode={false}
        onSelect={() => {}}
      />
    );

    expect(screen.getByRole("alert").textContent).toBe(beforeError);
    expect(
      screen.queryByText(/編集前プレビューを起動できませんでした/)
    ).toBeNull();
  });


  it("時間内に load しなければ接続エラー overlay と再読込ボタンを表示する", () => {
    vi.useFakeTimers();
    render(<BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />);

    act(() => {
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "対象アプリに接続できません — 起動ログを確認してください"
    );
    fireEvent.click(screen.getByRole("button", { name: "再読込" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("起動中...");
  });

  it("iframe が時間内に load したらエラーを出さない", () => {
    vi.useFakeTimers();
    render(<BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />);

    fireEvent.load(screen.getByTitle("編集前プレビュー"));
    act(() => {
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS + 5000);
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("停止中(running=false)は接続エラーに上書きしない", () => {
    vi.useFakeTimers();
    render(
      <BeforePreview
        info={{ ...runningInfo, running: false }}
        selectMode={false}
        onSelect={() => {}}
      />
    );
    act(() => {
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS + 1000);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("稼働中は緑点に視覚外テキスト「稼働中」を持つ", () => {
    render(<BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />);
    expect(screen.getByText("稼働中")).not.toBeNull();
  });

  it("選択モード中だけ操作説明を表示する", () => {
    const { rerender } = render(
      <BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />
    );
    expect(screen.queryByText(/矢印キーで移動、Enter で選択、Esc で終了/)).toBeNull();
    rerender(
      <BeforePreview info={runningInfo} selectMode={true} onSelect={() => {}} />
    );
    expect(screen.getByText(/矢印キーで移動、Enter で選択、Esc で終了/)).toBeTruthy();
  });

  it("選択モード開始で iframe にフォーカスを移し、候補を aria-live に出す", () => {
    const focus = vi.spyOn(HTMLIFrameElement.prototype, "focus");
    const { rerender, container } = render(
      <BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />
    );
    expect(focus).not.toHaveBeenCalled();
    rerender(
      <BeforePreview info={runningInfo} selectMode={true} onSelect={() => {}} />
    );
    expect(focus).toHaveBeenCalled();
    expect(focus.mock.contexts[0]).toBe(screen.getByTitle("編集前プレビュー"));

    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://localhost:5174",
          data: { type: "uim:hover-candidate", tag: "h1", text: "サンプルアプリ" },
        })
      );
    });
    expect(live.textContent).toBe('h1 "サンプルアプリ"');
    focus.mockRestore();
  });

  it("別 origin の候補通知は aria-live に出さない", () => {
    const { container } = render(
      <BeforePreview info={runningInfo} selectMode={true} onSelect={() => {}} />
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "http://evil.test",
          data: { type: "uim:hover-candidate", tag: "h1", text: "x" },
        })
      );
    });
    expect(container.querySelector('[aria-live="polite"]')!.textContent).toBe("");
  });
});
