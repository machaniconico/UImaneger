// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AfterPreview, LOAD_TIMEOUT_MS } from "./AfterPreview";
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

describe("AfterPreview", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("iframe の load まで起動中 overlay を表示し reloadKey 変更で再表示する", () => {
    const { rerender } = render(<AfterPreview info={runningInfo} reloadKey={0} />);

    expect(screen.getByRole("status").textContent).toContain("起動中...");
    fireEvent.load(screen.getByTitle("after"));
    expect(screen.queryByText("起動中...")).toBeNull();

    rerender(<AfterPreview info={runningInfo} reloadKey={1} />);
    expect(screen.getByRole("status").textContent).toContain("起動中...");
  });

  it("running=false の通常停止なら停止中 overlay を表示する", () => {
    render(
      <AfterPreview
        info={{ ...runningInfo, running: false, afterProxyPort: null }}
      />
    );

    expect(screen.getByRole("status").textContent).toContain("停止中です…");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("iframe が時間内に load したらエラーを出さない", () => {
    vi.useFakeTimers();

    render(<AfterPreview info={runningInfo} />);

    fireEvent.load(screen.getByTitle("after"));
    act(() => {
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS + 5000);
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("時間内に load しなければ接続エラー overlay を表示する", () => {
    vi.useFakeTimers();

    render(<AfterPreview info={runningInfo} />);

    act(() => {
      vi.advanceTimersByTime(LOAD_TIMEOUT_MS);
    });

    expect(screen.getByRole("alert").textContent).toContain(
      "対象アプリに接続できません — 起動ログを確認してください"
    );
  });
});
