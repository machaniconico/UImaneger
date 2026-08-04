// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "./App";
import { api } from "./lib/api";
import type { DomDescriptor, ProjectInfo } from "./lib/types";

vi.mock("./lib/api", () => ({
  api: { status: vi.fn() },
  getErrorMessage: (error: unknown) =>
    error instanceof Error && error.message ? error.message : String(error),
}));

vi.mock("./components/ProjectBar.tsx", () => ({
  ProjectBar: ({ info, hasKey, selectMode, setSelectMode }: any) => (
    <section aria-label="project-bar">
      <div>project:{info?.name ?? "none"}</div>
      <div>has-key:{String(hasKey)}</div>
      <button onClick={() => setSelectMode(!selectMode)}>
        {selectMode ? "select-on" : "select-off"}
      </button>
    </section>
  ),
}));

vi.mock("./components/BeforePreview.tsx", () => ({
  BeforePreview: ({ selectMode, onSelect }: any) => {
    const descriptor: DomDescriptor = {
      tag: "button",
      classes: [],
      attrs: {},
      domPath: "body>button",
      textSnippet: "Demo",
    };
    return (
      <section aria-label="before-preview">
        <div>select-mode:{String(selectMode)}</div>
        <button onClick={() => onSelect(descriptor)}>select-demo</button>
      </section>
    );
  },
}));

vi.mock("./components/AfterPreview.tsx", () => ({
  AfterPreview: ({ reloadKey }: any) => (
    <section aria-label="after-preview">reload-key:{reloadKey}</section>
  ),
}));

vi.mock("./components/Chat.tsx", () => ({
  Chat: ({ selected, hasKey }: any) => (
    <section aria-label="chat">
      selected:{selected?.tag ?? "none"} has-key:{String(hasKey)}
    </section>
  ),
}));

vi.mock("./components/GitPanel.tsx", () => ({
  GitPanel: ({ info }: any) => (
    <section aria-label="git-panel">git:{info?.name ?? "none"}</section>
  ),
}));

vi.mock("./components/StatusPanel.tsx", () => ({
  StatusPanel: () => <section aria-label="status-panel" />,
}));

const info: ProjectInfo = {
  root: "/demo",
  name: "demo",
  framework: "Vite",
  runCommand: "npm run dev",
  running: true,
  beforeProxyPort: 6174,
  afterProxyPort: 6175,
  targetPortBefore: 5173,
  targetPortAfter: 5173,
  gitMode: "worktree",
};

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("loads status into the workspace shell and wires selected elements into chat", async () => {
    vi.mocked(api.status).mockResolvedValue({
      info,
      hasKey: true,
      logs: [],
      undoDepth: 0,
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("project:demo")).not.toBeNull();
    });
    expect(screen.getByText("has-key:true")).not.toBeNull();
    expect(screen.getByLabelText("git-panel").textContent).toContain("git:demo");
    expect(screen.getByLabelText("chat").textContent).toContain("selected:none");

    fireEvent.click(screen.getByText("select-off"));
    expect(screen.getByText("select-mode:true")).not.toBeNull();

    fireEvent.click(screen.getByText("select-demo"));
    expect(screen.getByLabelText("chat").textContent).toContain("selected:button");
    expect(screen.getByText("select-mode:false")).not.toBeNull();
  });

  it("reloads the after preview when an edit is applied", async () => {
    vi.mocked(api.status).mockResolvedValue({
      info,
      hasKey: true,
      logs: [],
      undoDepth: 0,
    });

    render(<App />);

    await screen.findByText("reload-key:0");
    window.dispatchEvent(new Event("uim:applied"));

    await screen.findByText("reload-key:1");
  });
});
