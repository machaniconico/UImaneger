// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AfterPreview } from "./AfterPreview";
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

describe("AfterPreview", () => {
  afterEach(cleanup);

  it("iframe の load まで起動中 overlay を表示し reloadKey 変更で再表示する", () => {
    const { rerender } = render(<AfterPreview info={runningInfo} reloadKey={0} />);

    expect(screen.getByRole("status").textContent).toContain("起動中...");
    fireEvent.load(screen.getByTitle("after"));
    expect(screen.queryByText("起動中...")).toBeNull();

    rerender(<AfterPreview info={runningInfo} reloadKey={1} />);
    expect(screen.getByRole("status").textContent).toContain("起動中...");
  });

  it("running=false なら接続エラー overlay を表示する", () => {
    render(<AfterPreview info={{ ...runningInfo, running: false }} />);

    expect(screen.getByRole("alert").textContent).toContain(
      "対象アプリに接続できません"
    );
  });
});
