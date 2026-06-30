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

  it("running=false なら接続エラー overlay を表示する", () => {
    render(
      <BeforePreview
        info={{ ...runningInfo, running: false }}
        selectMode={false}
        onSelect={() => {}}
      />
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "対象アプリに接続できません"
    );
  });

  it("beforeProxyPort がなく beforeError がある場合は起動失敗理由を表示する", () => {
    render(
      <BeforePreview
        info={{
          ...runningInfo,
          beforeProxyPort: null,
          beforeError: "port unavailable",
        }}
        selectMode={false}
        onSelect={() => {}}
      />
    );

    expect(
      screen.getByText(
        "編集前プレビューを起動できませんでした: port unavailable"
      )
    ).not.toBeNull();
  });
});
