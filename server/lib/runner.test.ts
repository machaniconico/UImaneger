import { describe, it, expect, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  detectRunnerFromFacts,
  extractPort,
  extractPortForRunnerOutput,
  reduceDetectedPort,
  killGroup,
  type ProjectFacts,
} from "./runner.ts";

function emptyFacts(over: Partial<ProjectFacts> = {}): ProjectFacts {
  return {
    hasPackageJson: false,
    dependencies: {},
    devDependencies: {},
    scripts: {},
    devScript: "",
    startScript: "",
    pkgName: undefined,
    hasGemfile: false,
    hasRailsBin: false,
    hasManagePy: false,
    hasGoMod: false,
    hasComposerJson: false,
    hasArtisan: false,
    hasPublicIndexPhp: false,
    hasIndexPhp: false,
    hasPublicDir: false,
    hasIndexHtml: false,
    hasSvelteConfig: false,
    hasAstroConfig: false,
    hasNuxtConfig: false,
    hasVueConfig: false,
    hasRemixConfig: false,
    ...over,
  };
}

function nodeFacts(
  deps: Record<string, string> = {},
  scripts: Record<string, string> = {},
  extra: Partial<ProjectFacts> = {}
): ProjectFacts {
  return emptyFacts({
    hasPackageJson: true,
    dependencies: deps,
    scripts,
    devScript: scripts.dev ?? "",
    startScript: scripts.start ?? "",
    ...extra,
  });
}

describe("detectRunnerFromFacts — Node.js 系 FW 判別", () => {
  it("detects Vite via dependency", () => {
    const plan = detectRunnerFromFacts(nodeFacts({ vite: "^5.0.0" }, {}), 5173);
    expect(plan.framework).toBe("Vite");
    expect(plan.knownPort).toBe(true);
    expect(plan.args).toContain(String(5173));
    expect(plan.args).toContain("--strictPort");
  });

  it("detects Vite via dev script heuristic", () => {
    const plan = detectRunnerFromFacts(nodeFacts({}, { dev: "vite" }), 5173);
    expect(plan.framework).toBe("Vite");
  });

  it("detects Next.js via dependency", () => {
    const plan = detectRunnerFromFacts(nodeFacts({ next: "^14.0.0" }, {}), 3000);
    expect(plan.framework).toBe("Next.js");
    expect(plan.knownPort).toBe(true);
    expect(plan.args).toContain("-p");
  });

  it("detects Next.js via dev script", () => {
    const plan = detectRunnerFromFacts(nodeFacts({}, { dev: "next dev" }), 3000);
    expect(plan.framework).toBe("Next.js");
  });

  it("detects Create React App and sets PORT env", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({ "react-scripts": "5.0.1" }, {}),
      3000
    );
    expect(plan.framework).toBe("Create React App");
    expect(plan.knownPort).toBe(true);
    expect(plan.env?.PORT).toBe("3000");
    expect(plan.env?.BROWSER).toBe("none");
  });
});

describe("detectRunnerFromFacts — 非 Node プロジェクト判別", () => {
  it("detects Django via manage.py", () => {
    const plan = detectRunnerFromFacts(emptyFacts({ hasManagePy: true }), 8000);
    expect(plan.framework).toBe("Django");
    expect(plan.knownPort).toBe(true);
    expect(plan.args).toContain("runserver");
    expect(plan.args).toContain(String(8000));
  });

  it("detects Rails via Gemfile + bin/rails", () => {
    const plan = detectRunnerFromFacts(
      emptyFacts({ hasGemfile: true, hasRailsBin: true }),
      3000
    );
    expect(plan.framework).toBe("Rails");
    expect(plan.command).toBe("bin/rails");
    expect(plan.args).toContain("-p");
  });

  it("detects Laravel via artisan", () => {
    const plan = detectRunnerFromFacts(emptyFacts({ hasArtisan: true }), 8000);
    expect(plan.framework).toBe("Laravel");
    expect(plan.args).toContain("artisan");
  });

  it("detects static site via index.html", () => {
    const plan = detectRunnerFromFacts(emptyFacts({ hasIndexHtml: true }), 5000);
    expect(plan.framework).toBe("Static");
    expect(plan.knownPort).toBe(true);
    expect(plan.args).toContain("serve");
  });

  it("throws a clear error when nothing is detected", () => {
    expect(() => detectRunnerFromFacts(emptyFacts(), 3000)).toThrow(
      /runCommand/
    );
  });
});

describe("detectRunnerFromFacts — generic node fallback", () => {
  it("falls back to npm run dev with PORT env (knownPort=false)", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({}, { dev: "node server.js" }, { pkgName: "myapp" }),
      3000
    );
    expect(plan.framework).toContain("myapp");
    expect(plan.knownPort).toBe(false);
    expect(plan.args).toEqual(["run", "dev"]);
    expect(plan.env?.PORT).toBe("3000");
  });

  it("does not treat hyphenated script names as framework commands", () => {
    expect(
      detectRunnerFromFacts(nodeFacts({}, { dev: "my-next dev" }), 3000)
        .framework
    ).toBe("node");
    expect(
      detectRunnerFromFacts(nodeFacts({}, { dev: "next-foo --serve" }), 3000)
        .framework
    ).toBe("node");
  });
});

describe("detectRunnerFromFacts — conflict priority", () => {
  it("prefers Next.js over Vite when both dependencies are present", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({ next: "^14.0.0", vite: "^5.0.0" }, {}),
      3000
    );
    expect(plan.framework).toBe("Next.js");
  });

  it("prefers Node project detection over non-Node files", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({ vite: "^5.0.0" }, {}, { hasGemfile: true, hasRailsBin: true }),
      5173
    );
    expect(plan.framework).toBe("Vite");
  });

  it("prefers a Next dev script over a Vite dependency", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({ vite: "^5.0.0" }, { dev: "next dev" }),
      3000
    );
    expect(plan.framework).toBe("Next.js");
  });
});

describe("extractPort — scheme付きURL", () => {
  it("extracts port from Vite-style Local line", () => {
    expect(extractPort("  ➜  Local:   http://localhost:5173/")).toBe(5173);
  });

  it("extracts port from plain http URL anywhere in the line", () => {
    expect(extractPort("Server running at http://localhost:9000")).toBe(9000);
  });

  it("extracts port from IPv4 host", () => {
    expect(extractPort("* Listening on http://0.0.0.0:3000")).toBe(3000);
  });

  it("extracts port from IPv6 host", () => {
    expect(extractPort("Listening on http://[::1]:4000/")).toBe(4000);
  });
});

describe("extractPort — 裸数値 / listening on 形式", () => {
  it("extracts port from 'listening on :PORT'", () => {
    expect(extractPort("listening on :8080")).toBe(8080);
  });

  it("extracts port from 'listening on port PORT'", () => {
    expect(extractPort("listening on port 3000")).toBe(3000);
  });

  it("extracts port from 'Server running on port PORT'", () => {
    expect(extractPort("Server running on port 8080")).toBe(8080);
  });

  it("extracts port from bare 'started on PORT'", () => {
    expect(extractPort("started on 7000")).toBe(7000);
  });
});

describe("extractPort — 境界値", () => {
  it("returns null for lines without a port", () => {
    expect(extractPort("Compiling... done")).toBeNull();
    expect(extractPort("")).toBeNull();
  });

  it("rejects out-of-range port numbers (>65535)", () => {
    expect(extractPort("http://localhost:99999/")).toBeNull();
  });

  it("rejects too-short port-like numbers (<2 digits)", () => {
    // 1 桁の数字は \\d{2,5} にマッチしない
    expect(extractPort("listening on :8")).toBeNull();
  });

  it("returns the first match when multiple patterns could match", () => {
    // URL パターンが先に 3000 を拾うべき
    expect(
      extractPort("Local: http://localhost:3000 also listening on :4000")
    ).toBe(3000);
  });
});

describe("extractPortForRunnerOutput — knownPort の上書き制限", () => {
  it("knownPort では無関係な依存ポートを無視し listen 行だけ採用する", () => {
    expect(
      extractPortForRunnerOutput("cache: redis://localhost:6379", true)
    ).toBeNull();
    expect(
      extractPortForRunnerOutput("db: postgres://localhost:5432", true)
    ).toBeNull();
    expect(
      extractPortForRunnerOutput(
        "dependency dashboard: http://127.0.0.1:6379",
        true
      )
    ).toBeNull();

    expect(
      extractPortForRunnerOutput("  ➜  Local:   http://localhost:61234/", true)
    ).toBe(61234);
  });

  it("knownPort でない場合は従来どおり最初に見つかったポートを採用する", () => {
    expect(
      extractPortForRunnerOutput(
        "dependency dashboard: http://127.0.0.1:6379",
        false
      )
    ).toBe(6379);
  });

  it("Django/旧 Laravel の development server 行を listen 行として拾う", () => {
    expect(
      extractPortForRunnerOutput(
        "Starting development server at http://127.0.0.1:8001/",
        true
      )
    ).toBe(8001);
  });
});

describe("reduceDetectedPort — 次ポート決定", () => {
  it("knownPort: listen 行の実ポートに上書きする(#11 の再検出)", () => {
    // assumed port 3000 で起動 → 実際は 3001 に listen
    expect(
      reduceDetectedPort(3000, "- Local: http://localhost:3001", true)
    ).toBe(3001);
  });

  it("knownPort: 無関係な依存ポート行では上書きしない(デコイ耐性)", () => {
    expect(
      reduceDetectedPort(3000, "cache: redis://localhost:6379", true)
    ).toBe(3000);
  });

  it("非 knownPort: 最初に検出したポートを維持する(first-wins、last-wins 回帰を防ぐ)", () => {
    // 最初の実ポートを採用
    expect(reduceDetectedPort(0, "listening on http://localhost:4000", false)).toBe(
      4000
    );
    // 後続の無関係トークンでは 4000 から動かさない
    expect(
      reduceDetectedPort(4000, "Proxying /api -> http://localhost:9999", false)
    ).toBe(4000);
  });

  it("同一ポート・ポート無し行では現在値を維持する", () => {
    expect(reduceDetectedPort(5173, "  Local: http://localhost:5173/", true)).toBe(
      5173
    );
    expect(reduceDetectedPort(5173, "compiling...", true)).toBe(5173);
  });
});

describe("killGroup", () => {
  it("sends SIGKILL to the process group even when the leader has already exited", async () => {
    const proc = {
      pid: 12345,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      await killGroup(proc, { graceMs: 0 });

      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
      expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
