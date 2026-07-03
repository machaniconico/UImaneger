// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BeforePreview } from "./BeforePreview";
import type { ProjectInfo } from "../lib/types";

const runningInfo: ProjectInfo = {
  root: "/demo",
  name: "demo",
  framework: "vite",
  runCommand: "npm run dev",
  running: true,
  beforeProxyPort: 5174,
  afterProxyPort: 5175,
  gitMode: "worktree",
};

describe("BeforePreview", () => {
  afterEach(cleanup);

  it("iframe の load まで起動中 overlay を表示する", () => {
    render(
      <BeforePreview info={runningInfo} selectMode={false} onSelect={() => {}} />
    );

    expect(screen.getByRole("status").textContent).toContain("起動中...");
    fireEvent.load(screen.getByTitle("before"));
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

});
