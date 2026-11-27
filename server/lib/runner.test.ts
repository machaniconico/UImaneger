import { describe, it, expect, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRunner,
  detectRunnerFromFacts,
  extractPort,
  extractPortForRunnerOutput,
  reduceDetectedPort,
  splitOutputChunk,
  killGroup,
  readFacts,
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
    hasGoMain: false,
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

  it("detects modern React Router and respects pnpm", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts(
        { "@react-router/dev": "^7.0.0" },
        { dev: "react-router dev" },
        { packageManager: "pnpm" }
      ),
      5173
    );
    expect(plan.framework).toBe("React Router");
    expect(plan.command).toBe("pnpm");
    expect(plan.args).toEqual(["run", "dev"]);
  });

  it("detects modern Remix through @remix-run/dev", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({ "@remix-run/dev": "^2.0.0" }, { dev: "remix vite:dev" }),
      5173
    );
    expect(plan.framework).toBe("Remix");
    expect(plan.args).toEqual(["run", "dev"]);
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
    expect(plan.command).toBe("ruby");
    expect(plan.args).toContain("bin/rails");
    expect(plan.args).toContain("-p");
  });

  it("detects Laravel via artisan", () => {
    const plan = detectRunnerFromFacts(emptyFacts({ hasArtisan: true }), 8000);
    expect(plan.framework).toBe("Laravel");
    expect(plan.args).toContain("artisan");
  });

  it("detects only a root Go main package as an executable server", () => {
    const plan = detectRunnerFromFacts(
      emptyFacts({ hasGoMod: true, hasGoMain: true }),
      8080
    );
    expect(plan.framework).toBe("Go");
    expect(plan.args).toEqual(["run", "."]);
    expect(() =>
      detectRunnerFromFacts(emptyFacts({ hasGoMod: true }), 8080)
    ).toThrow(/runCommand/);
  });

  it("detects Spring Boot Maven and uses the repository wrapper", () => {
    const plan = detectRunnerFromFacts(
      emptyFacts({ hasSpringBootMaven: true, hasMavenWrapper: true }),
      8080
    );
    expect(plan.framework).toBe("Spring Boot (Maven)");
    expect(plan.command).toContain("mvnw");
    expect(plan.args.join(" ")).toContain("server.port=8080");
  });

  it("detects Spring Boot Gradle and pins the server port", () => {
    const plan = detectRunnerFromFacts(
      emptyFacts({ hasSpringBootGradle: true, hasGradleWrapper: true }),
      8081
    );
    expect(plan.framework).toBe("Spring Boot (Gradle)");
    expect(plan.command).toContain("gradlew");
    expect(plan.args.join(" ")).toContain("server.port=8081");
  });

  it("detects ASP.NET Core web projects", () => {
    const plan = detectRunnerFromFacts(
      emptyFacts({ aspNetProject: "WebApp.csproj" }),
      5050
    );
    expect(plan.framework).toBe("ASP.NET Core");
    expect(plan.command).toBe("dotnet");
    expect(plan.args).toContain("WebApp.csproj");
    expect(plan.env?.ASPNETCORE_URLS).toBe("http://127.0.0.1:5050");
  });

  it("detects Phoenix projects", () => {
    const plan = detectRunnerFromFacts(emptyFacts({ hasPhoenix: true }), 4000);
    expect(plan.framework).toBe("Phoenix");
    expect(plan.command).toBe("mix");
    expect(plan.args).toEqual(["phx.server"]);
    expect(plan.env?.PORT).toBe("4000");
  });

  it("detects static site via index.html", () => {
    const plan = detectRunnerFromFacts(emptyFacts({ hasIndexHtml: true }), 5000);
    expect(plan.framework).toBe("Static");
    expect(plan.knownPort).toBe(true);
    expect(plan.command).toBe(process.execPath);
    expect(plan.args.some((arg) => arg.endsWith("static-server.mjs"))).toBe(true);
  });

  it("throws a clear error when nothing is detected", () => {
    expect(() => detectRunnerFromFacts(emptyFacts(), 3000)).toThrow(
      /runCommand/
    );
  });
});

describe("readFacts — backend project markers", () => {
  it("prefers executable project Python in .venv, then venv, for Django", () => {
    const root = mkdtempSync(join(tmpdir(), "uim-django-runner-"));
    const [bin, executable] = process.platform === "win32"
      ? ["Scripts", "python.exe"]
      : ["bin", "python"];
    const previousPath = process.env.PATH;
    const fakeBin = mkdtempSync(join(tmpdir(), "uim-fake-bin-"));
    try {
      // ホストの PATH に依存しないよう、python だけがある PATH に固定する。
      writeFileSync(join(fakeBin, "python"), "", { mode: 0o755 });
      process.env.PATH = fakeBin;
      writeFileSync(join(root, "manage.py"), "DJANGO_SETTINGS_MODULE\nexecute_from_command_line\n");
      expect(detectRunner(root, 8000).command).toBe("python");

      const venv = join(root, "venv", bin);
      const dotVenv = join(root, ".venv", bin);
      const venvPython = join(venv, executable);
      const dotVenvPython = join(dotVenv, executable);
      mkdirSync(venv, { recursive: true });
      mkdirSync(dotVenv, { recursive: true });
      writeFileSync(venvPython, "", { mode: 0o755 });
      mkdirSync(dotVenvPython);
      expect(detectRunner(root, 8000).command).toBe(venvPython);

      rmSync(dotVenvPython, { recursive: true });
      writeFileSync(dotVenvPython, "", { mode: 0o755 });
      expect(detectRunner(root, 8000).command).toBe(dotVenvPython);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "falls back to python3 when no venv exists and only python3 is on PATH",
    () => {
      const root = mkdtempSync(join(tmpdir(), "uim-django-python3-"));
      const fakeBin = mkdtempSync(join(tmpdir(), "uim-fake-bin-"));
      const previousPath = process.env.PATH;
      try {
        writeFileSync(join(root, "manage.py"), "DJANGO_SETTINGS_MODULE\nexecute_from_command_line\n");
        writeFileSync(join(fakeBin, "python3"), "", { mode: 0o755 });
        process.env.PATH = fakeBin;
        expect(detectRunner(root, 8000).command).toBe("python3");

        // python が PATH にあればそれを優先する(実行権限のないファイルは数えない)
        writeFileSync(join(fakeBin, "python"), "", { mode: 0o644 });
        expect(detectRunner(root, 8000).command).toBe("python3");
        chmodSync(join(fakeBin, "python"), 0o755);
        expect(detectRunner(root, 8000).command).toBe("python");
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
        rmSync(fakeBin, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "resolves empty and relative PATH entries against the project root",
    () => {
      const root = mkdtempSync(join(tmpdir(), "uim-django-relpath-"));
      const previousPath = process.env.PATH;
      try {
        writeFileSync(join(root, "manage.py"), "DJANGO_SETTINGS_MODULE\nexecute_from_command_line\n");
        writeFileSync(join(root, "python3"), "", { mode: 0o755 });
        process.env.PATH = ":/nonexistent";
        expect(detectRunner(root, 8000).command).toBe("python3");
        mkdirSync(join(root, "bin"));
        rmSync(join(root, "python3"));
        writeFileSync(join(root, "bin", "python3"), "", { mode: 0o755 });
        process.env.PATH = "bin";
        expect(detectRunner(root, 8000).command).toBe("python3");

        // PATH 未定義は「既定パス」で、プロジェクト直下は探さない
        delete process.env.PATH;
        const hostHasPython = existsSync("/usr/bin/python") || existsSync("/bin/python");
        const hostHasPython3 = existsSync("/usr/bin/python3") || existsSync("/bin/python3");
        expect(detectRunner(root, 8000).command).toBe(
          !hostHasPython && hostHasPython3 ? "python3" : "python"
        );
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "skips non-executable and dangling venv interpreters",
    () => {
      const root = mkdtempSync(join(tmpdir(), "uim-django-badvenv-"));
      const fakeBin = mkdtempSync(join(tmpdir(), "uim-fake-bin-"));
      const previousPath = process.env.PATH;
      try {
        writeFileSync(join(root, "manage.py"), "DJANGO_SETTINGS_MODULE\nexecute_from_command_line\n");
        writeFileSync(join(fakeBin, "python"), "", { mode: 0o755 });
        process.env.PATH = fakeBin;
        mkdirSync(join(root, ".venv", "bin"), { recursive: true });
        writeFileSync(join(root, ".venv", "bin", "python"), "", { mode: 0o644 });
        mkdirSync(join(root, "venv", "bin"), { recursive: true });
        symlinkSync(join(root, "missing-python"), join(root, "venv", "bin", "python"));
        expect(detectRunner(root, 8000).command).toBe("python");
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
        rmSync(fakeBin, { recursive: true, force: true });
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it("reads Spring Boot, ASP.NET Core, and Phoenix markers from project files", () => {
    const root = mkdtempSync(join(tmpdir(), "uim-runner-facts-"));
    try {
      writeFileSync(
        join(root, "pom.xml"),
        "<dependency><artifactId>spring-boot-starter-web</artifactId></dependency>"
      );
      writeFileSync(
        join(root, "build.gradle.kts"),
        'plugins { id("org.springframework.boot") version "3.5.0" }'
      );
      writeFileSync(
        join(root, "WebApp.csproj"),
        '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'
      );
      writeFileSync(join(root, "mix.exs"), '{:phoenix, "~> 1.7"}');
      writeFileSync(join(root, "mvnw.cmd"), "");
      writeFileSync(join(root, "gradlew.bat"), "");

      const facts = readFacts(root);
      expect(facts.hasSpringBootMaven).toBe(true);
      expect(facts.hasMavenWrapper).toBe(true);
      expect(facts.hasSpringBootGradle).toBe(true);
      expect(facts.hasGradleWrapper).toBe(true);
      expect(facts.aspNetProject).toBe("WebApp.csproj");
      expect(facts.hasPhoenix).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects generic manage.py and go.mod files without web entrypoints", () => {
    const root = mkdtempSync(join(tmpdir(), "uim-runner-entrypoints-"));
    try {
      writeFileSync(join(root, "manage.py"), "print('maintenance helper')");
      writeFileSync(join(root, "go.mod"), "module example.test/library\n");
      writeFileSync(join(root, "library.go"), "package library\n");
      let facts = readFacts(root);
      expect(facts.hasManagePy).toBe(false);
      expect(facts.hasGoMain).toBe(false);

      writeFileSync(
        join(root, "manage.py"),
        "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'app.settings')\nexecute_from_command_line(sys.argv)\n"
      );
      writeFileSync(join(root, "main.go"), "package main\nfunc main() {}\n");
      facts = readFacts(root);
      expect(facts.hasManagePy).toBe(true);
      expect(facts.hasGoMain).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("prefers a full-stack application server over its Vite asset server", () => {
    const plan = detectRunnerFromFacts(
      nodeFacts({ vite: "^5.0.0" }, {}, { hasGemfile: true, hasRailsBin: true }),
      5173
    );
    expect(plan.framework).toBe("Rails");
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

describe("splitOutputChunk", () => {
  it("reassembles a port log split across process chunks", () => {
    const first = splitOutputChunk("", "Listening on http://localhost:30");
    expect(first.lines).toEqual([]);
    const second = splitOutputChunk(first.remainder, "80/\nready\n");
    expect(second.lines).toEqual([
      "Listening on http://localhost:3080/",
      "ready",
    ]);
    expect(second.remainder).toBe("");
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
  it("uses the platform process-tree shutdown path even when the leader has already exited", async () => {
    const proc = {
      pid: 12345,
      exitCode: 0,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);

    try {
      await killGroup(proc, { graceMs: 0 });

      if (process.platform === "win32") {
        expect(killSpy).not.toHaveBeenCalled();
      } else {
        expect(killSpy).toHaveBeenCalledWith(-12345, "SIGTERM");
        expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
      }
      expect(proc.kill).not.toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
    }
  });
});
