// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App, hasDevServerHmr } from "./App";
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
  AfterPreview: ({ info, reloadKey }: any) => (
    <section aria-label="after-preview">
      <span>reload-key:{reloadKey}</span>
      <span>framework:{info?.framework ?? "none"}</span>
    </section>
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
    // info.root 変化で選択状態を初期化する passive effect を先に flush する。
    // 負荷下では waitFor の検出がその effect より先になり、直後のクリックを打ち消すことがあった。
    await act(async () => {});
    expect(screen.getByText("has-key:true")).not.toBeNull();
    expect(screen.getByLabelText("git-panel").textContent).toContain("git:demo");
    expect(screen.getByLabelText("chat").textContent).toContain("selected:none");

    fireEvent.click(screen.getByText("select-off"));
    expect(screen.getByText("select-mode:true")).not.toBeNull();

    fireEvent.click(screen.getByText("select-demo"));
    expect(screen.getByLabelText("chat").textContent).toContain("selected:button");
    expect(screen.getByText("select-mode:false")).not.toBeNull();
  });

  it("leaves HMR frameworks to the dev server instead of remounting the after preview", async () => {
    vi.mocked(api.status).mockResolvedValue({
      info,
      hasKey: true,
      logs: [],
      undoDepth: 0,
    });

    render(<App />);

    await screen.findByText("reload-key:0");
    // プロジェクト情報の読込前に送ると HMR 判定が効かないため、読込を待つ
    await screen.findByText(/^framework:(?!none)/);
    act(() => {
      window.dispatchEvent(new Event("uim:applied"));
    });
    // 作り直すと HMR 接続前の更新を取りこぼし得るので、Vite では reloadKey を進めない
    expect(screen.getByText("reload-key:0")).not.toBeNull();
  });

  it("reloads the after preview once when an edit is applied without HMR", async () => {
    vi.mocked(api.status).mockResolvedValue({
      info: { ...info, framework: "Django", runCommand: "python manage.py runserver" },
      hasKey: true,
      logs: [],
      undoDepth: 0,
    });

    render(<App />);

    await screen.findByText("reload-key:0");
    // プロジェクト情報の読込前に送ると HMR 判定が効かないため、読込を待つ
    await screen.findByText(/^framework:(?!none)/);
    act(() => {
      window.dispatchEvent(new Event("uim:applied"));
    });
    expect(screen.getByText("reload-key:1")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new Event("uim:applied"));
    });
    expect(screen.getByText("reload-key:2")).not.toBeNull();
  });

  it("knows which frameworks reload through HMR", () => {
    for (const framework of ["Vite", "Next.js", "Nuxt", "SvelteKit", "Astro", "Angular", "Vue CLI", "Create React App", "Remix", "React Router"]) {
      expect(hasDevServerHmr(framework)).toBe(true);
    }
    for (const framework of ["Django", "Rails", "Laravel", "PHP", "Static", "Go", "Phoenix", "Node", undefined]) {
      expect(hasDevServerHmr(framework)).toBe(false);
    }
    // dev script が無く start script で起動した React Router / Remix は本番サーバのことが多い
    expect(hasDevServerHmr("Remix", "npm run start")).toBe(false);
    expect(hasDevServerHmr("React Router", "pnpm run start")).toBe(false);
    expect(hasDevServerHmr("Remix", "npm run dev")).toBe(true);
    expect(hasDevServerHmr("React Router", "npx react-router dev --port 6100")).toBe(true);
    // 起動設定で任意コマンドを指定した場合は framework が "custom" になり再読込する
    expect(hasDevServerHmr("custom", "node server.js")).toBe(false);
  });
});
