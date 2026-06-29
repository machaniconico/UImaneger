import { describe, it, expect } from "vitest";
import {
  detectRunnerFromFacts,
  extractPort,
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
