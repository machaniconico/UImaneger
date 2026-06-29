import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";

export interface RunnerPlan {
  framework: string;
  command: string;
  args: string[];
  /** ポートをコマンド側で固定できるか (false の場合は stdout から検出) */
  knownPort: boolean;
  env?: Record<string, string>;
}

/**
 * 検出に必要な事実情報。ファイルシステム非依存の純粋なデータ。
 * detectRunnerFromFacts への入力。
 */
export interface ProjectFacts {
  hasPackageJson: boolean;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  scripts: Record<string, string>;
  devScript: string;
  startScript: string;
  pkgName?: string;
  hasGemfile: boolean;
  hasRailsBin: boolean;
  hasManagePy: boolean;
  hasGoMod: boolean;
  hasComposerJson: boolean;
  hasArtisan: boolean;
  hasPublicIndexPhp: boolean;
  hasIndexPhp: boolean;
  hasPublicDir: boolean;
  hasIndexHtml: boolean;
  hasSvelteConfig: boolean;
  hasAstroConfig: boolean;
  hasNuxtConfig: boolean;
  hasVueConfig: boolean;
  hasRemixConfig: boolean;
}

/**
 * プロジェクトの起動方法を純粋関数として検出する。
 * ファイルシステムアクセスを行わないため scripts/runner-selftest.mjs で単体テスト可能。
 * 依存 → dev script ヒューリスティック → 非Node ファイル存在 の順で判定。
 */
export function detectRunnerFromFacts(
  facts: ProjectFacts,
  port: number
): RunnerPlan {
  if (facts.hasPackageJson) {
    const deps: Record<string, string> = {
      ...facts.dependencies,
      ...facts.devDependencies,
    };
    const devScript = facts.devScript || facts.startScript || "";

    // --- Node.js 系 FW (依存パッケージを最優先) ---
    if (
      deps.next ||
      /(?<![\w-])next(?![\w-])(?:\s+dev)?/.test(devScript)
    ) {
      return {
        framework: "Next.js",
        command: "npx",
        args: ["next", "dev", "-p", String(port)],
        knownPort: true,
      };
    }
    if (
      deps.nuxt ||
      facts.hasNuxtConfig ||
      /(?<![\w-])nuxt(?![\w-])/.test(devScript)
    ) {
      return {
        framework: "Nuxt",
        command: "npx",
        args: ["nuxt", "dev", "--port", String(port)],
        knownPort: true,
      };
    }
    if (deps.remix || facts.hasRemixConfig) {
      // Remix は vite 上で動くが remix コマンドがあれば明示的に扱う
      return {
        framework: "Remix",
        command: "npx",
        args: ["remix", "vite:dev", "--port", String(port)],
        knownPort: true,
      };
    }
    if (deps["@sveltejs/kit"] || facts.hasSvelteConfig) {
      // SvelteKit は vite ベース、--port で固定可能
      return {
        framework: "SvelteKit",
        command: "npx",
        args: ["vite", "dev", "--port", String(port), "--strictPort"],
        knownPort: true,
      };
    }
    if (deps.astro || facts.hasAstroConfig) {
      return {
        framework: "Astro",
        command: "npx",
        args: ["astro", "dev", "--port", String(port)],
        knownPort: true,
      };
    }
    if (deps.vite || /(?<![\w-])vite(?![\w-])/.test(devScript)) {
      return {
        framework: "Vite",
        command: "npx",
        args: ["vite", "--port", String(port), "--strictPort"],
        knownPort: true,
      };
    }
    if (deps["@angular/cli"]) {
      return {
        framework: "Angular",
        command: "npx",
        args: ["ng", "serve", "--port", String(port)],
        knownPort: true,
      };
    }
    if (deps["@vue/cli-service"] || facts.hasVueConfig) {
      return {
        framework: "Vue CLI",
        command: "npx",
        args: ["vue-cli-service", "serve", "--port", String(port)],
        knownPort: true,
      };
    }
    if (deps["react-scripts"]) {
      return {
        framework: "Create React App",
        command: "npx",
        args: ["react-scripts", "start"],
        knownPort: true,
        env: { PORT: String(port), BROWSER: "none" },
      };
    }
    if (devScript) {
      // 汎用: プロジェクトの dev/start スクリプト。ポートは stdout から検出。
      return {
        framework: facts.pkgName ? `node (${facts.pkgName})` : "node",
        command: "npm",
        args: ["run", facts.devScript ? "dev" : "start"],
        knownPort: false,
        env: { PORT: String(port) },
      };
    }
  }

  // --- 非 Node プロジェクト ---
  if (facts.hasGemfile && facts.hasRailsBin) {
    return {
      framework: "Rails",
      command: "bin/rails",
      args: ["server", "-p", String(port)],
      knownPort: true,
    };
  }
  if (facts.hasManagePy) {
    return {
      framework: "Django",
      command: "python",
      args: ["manage.py", "runserver", String(port)],
      knownPort: true,
    };
  }
  if (facts.hasGoMod) {
    // Go は PORT env を読む慣習が多いが固定不可とみなし stdout から検出
    return {
      framework: "Go",
      command: "go",
      args: ["run", "."],
      knownPort: false,
      env: { PORT: String(port) },
    };
  }
  // PHP (Laravel artisan serve を優先、なければ php -S 内蔵サーバ)
  if (facts.hasArtisan) {
    return {
      framework: "Laravel",
      command: "php",
      args: ["artisan", "serve", "--port", String(port)],
      knownPort: true,
    };
  }
  if (facts.hasComposerJson || facts.hasPublicIndexPhp || facts.hasIndexPhp) {
    const docroot = facts.hasPublicDir ? "public" : ".";
    return {
      framework: "PHP",
      command: "php",
      args: ["-S", `localhost:${port}`, "-t", docroot],
      knownPort: true,
    };
  }

  // 静的サイト (index.html → npx serve)
  if (facts.hasIndexHtml) {
    return {
      framework: "Static",
      command: "npx",
      args: ["-y", "serve", "-l", String(port), "."],
      knownPort: true,
    };
  }

  throw new Error(
    "起動方法を自動検出できませんでした。open 時に runCommand を指定してください。"
  );
}

function readPkg(root: string): any | null {
  const p = join(root, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function hasAnyConfig(root: string, names: string[]): boolean {
  return names.some((n) => existsSync(join(root, n)));
}

/** ファイルシステムから ProjectFacts を構築する。 */
export function readFacts(root: string): ProjectFacts {
  const pkg = readPkg(root);
  const deps: Record<string, string> = pkg?.dependencies ?? {};
  const devDeps: Record<string, string> = pkg?.devDependencies ?? {};
  const scripts: Record<string, string> = pkg?.scripts ?? {};
  return {
    hasPackageJson: pkg != null,
    dependencies: deps,
    devDependencies: devDeps,
    scripts,
    devScript: scripts.dev ?? "",
    startScript: scripts.start ?? "",
    pkgName: pkg?.name,
    hasGemfile: existsSync(join(root, "Gemfile")),
    hasRailsBin: existsSync(join(root, "bin/rails")),
    hasManagePy: existsSync(join(root, "manage.py")),
    hasGoMod: existsSync(join(root, "go.mod")),
    hasComposerJson: existsSync(join(root, "composer.json")),
    hasArtisan: existsSync(join(root, "artisan")),
    hasPublicIndexPhp: existsSync(join(root, "public/index.php")),
    hasIndexPhp: existsSync(join(root, "index.php")),
    hasPublicDir: existsSync(join(root, "public")),
    hasIndexHtml: existsSync(join(root, "index.html")),
    hasSvelteConfig: hasAnyConfig(root, [
      "svelte.config.js",
      "svelte.config.mjs",
      "svelte.config.ts",
    ]),
    hasAstroConfig: hasAnyConfig(root, [
      "astro.config.mjs",
      "astro.config.js",
      "astro.config.ts",
    ]),
    hasNuxtConfig: hasAnyConfig(root, [
      "nuxt.config.js",
      "nuxt.config.mjs",
      "nuxt.config.ts",
    ]),
    hasVueConfig: hasAnyConfig(root, ["vue.config.js", "vue.config.mjs"]),
    hasRemixConfig: hasAnyConfig(root, ["remix.config.js"]),
  };
}

/**
 * プロジェクトの起動方法を検出する (言語/FW 非依存)。
 * 明示 override があればそれを最優先。
 */
export function detectRunner(
  root: string,
  port: number,
  override?: { command?: string; framework?: string }
): RunnerPlan {
  if (override?.command) {
    return {
      framework: override.framework || "custom",
      command: "sh",
      args: ["-c", override.command],
      knownPort: false, // override の場合はポートを stdout から拾う
      env: { PORT: String(port) },
    };
  }
  return detectRunnerFromFacts(readFacts(root), port);
}

export interface RunningTarget {
  proc: ChildProcess;
  plan: RunnerPlan;
  port: number;
  logs: string[];
}

function signalProcessGroup(
  proc: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM"
): void {
  if (typeof proc.pid === "number" && proc.pid > 0) {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when process-group signalling is unavailable.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Best effort cleanup only.
  }
}

function terminateProcessGroup(proc: ChildProcess): void {
  signalProcessGroup(proc, "SIGTERM");
  const timer = setTimeout(() => signalProcessGroup(proc, "SIGKILL"), 2_000);
  timer.unref?.();
}

/**
 * stdout 1行から待受ポートを抽出するための正規表現群。
 * 未知FWでも "Local:" / "localhost:PORT" / "listening on" / "Server running" 等
 * 主要な出力フォーマットをカバーする。上から順に試し、最初に一致したものを採用。
 */
export const PORT_PATTERNS: readonly RegExp[] = [
  // URL 形式: http(s)://host:PORT (Vite/Next/CRA/Nuxt/Astro/SvelteKit/Django/Laravel/php -S 等)
  /https?:\/\/(?:\[[0-9a-fA-F:]+\]|[^\s/:]+):(\d{2,5})\b/,
  // "Local:   http://host:PORT" (Vite/Next/Nuxt 等) — 上の URL パターンでも拾えるが明示的に
  /\bLocal:\s+https?:\/\/[^\s/:]+:(\d{2,5})\b/,
  // "Listening on host:PORT" / "listening on :PORT" / "listening on PORT" (Angular/Puma/Go)
  /[Ll]istening\s+on\s+(?:[^\s:]+)?:?(\d{2,5})\b/,
  // "Listening on port PORT"
  /[Ll]istening\s+on\s+port\s+(\d{2,5})\b/,
  // "Server running at host:PORT" / "Server running on port PORT"
  /Server\s+running\s+(?:at\s+(?:[^\s:]+)?:?|on\s+port\s+)(\d{2,5})\b/,
  // "started on host:PORT" / "started on PORT"
  /[Ss]tarted\s+on\s+(?:[^\s:]+)?:?(\d{2,5})\b/,
  // "started on 7000" / "listening on 7000" など scheme 無し裸ポート
  /\b(?:started|listening)\s+on\s+(\d{2,5})\b/,
  // "ready on http://host:PORT" (Next.js) は URL パターンでカバー済み
];

/** stdout 1行からポート番号を抽出。見つからなければ null。 */
export function extractPort(line: string): number | null {
  for (const re of PORT_PATTERNS) {
    const m = line.match(re);
    if (m) {
      const p = Number(m[1]);
      if (Number.isInteger(p) && p > 0 && p <= 65535) return p;
    }
  }
  return null;
}

/** 対象を起動し、ポートが listen するまで待つ。 */
export async function startTarget(
  root: string,
  port: number,
  override?: { command?: string; framework?: string },
  onLog?: (line: string) => void
): Promise<RunningTarget> {
  const plan = detectRunner(root, port, override);
  const logs: string[] = [];

  const proc = spawn(plan.command, plan.args, {
    cwd: root,
    env: { ...process.env, ...plan.env, FORCE_COLOR: "0" },
    shell: false,
    detached: true,
  });

  let spawnFailed = false;
  let spawnErrorMessage = "";
  proc.on("error", (e) => {
    spawnFailed = true;
    spawnErrorMessage = e.message;
  });

  let detectedPort = plan.knownPort ? port : 0;
  const collect = (buf: Buffer) => {
    const text = buf.toString();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      logs.push(line);
      if (logs.length > 500) logs.shift();
      onLog?.(line);
      if (!detectedPort) {
        const p = extractPort(line);
        if (p) detectedPort = p;
      }
    }
  };
  proc.stdout?.on("data", collect);
  proc.stderr?.on("data", collect);

  // ポート確定 & listen 待ち
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (spawnFailed) {
      terminateProcessGroup(proc);
      throw new Error(
        `${plan.command} を起動できません: ${spawnErrorMessage}`
      );
    }
    if (proc.exitCode !== null) {
      throw new Error(
        `対象の起動に失敗しました (exit ${proc.exitCode}).\n` +
          logs.slice(-15).join("\n")
      );
    }
    if (detectedPort && (await isListening(detectedPort))) {
      return { proc, plan, port: detectedPort, logs };
    }
    await sleep(300);
  }
  terminateProcessGroup(proc);
  throw new Error(
    "対象 dev server が時間内に起動しませんでした。\n" + logs.slice(-15).join("\n")
  );
}

function probeHost(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => {
      sock.destroy();
      resolve();
    });
    sock.on("error", () => {
      sock.destroy();
      reject();
    });
    sock.setTimeout(800, () => {
      sock.destroy();
      reject();
    });
  });
}

export function isListening(port: number): Promise<boolean> {
  return Promise.any([
    probeHost("127.0.0.1", port),
    probeHost("::1", port),
  ])
    .then(() => true)
    .catch(() => false);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function portFreeOn(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once("error", (err: NodeJS.ErrnoException) => {
      if (
        host === "::1" &&
        (err.code === "EADDRNOTAVAIL" || err.code === "EAFNOSUPPORT")
      ) {
        resolve(true);
        return;
      }
      resolve(false);
    });
    srv.listen(port, host, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** 空きポートを探す(IPv4/IPv6 両スタックで確認)。 */
export async function findFreePort(start: number): Promise<number> {
  const free4 = await portFreeOn("127.0.0.1", start);
  const free6 = await portFreeOn("::1", start);
  if (!free4 || !free6) {
    return findFreePort(start + 1);
  }
  return start;
}
