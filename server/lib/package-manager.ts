import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export type PackageManagerName = "npm" | "pnpm" | "yarn" | "bun";

export interface PackageManagerInfo {
  name: PackageManagerName;
  version?: string;
}

export interface CommandPlan {
  command: string;
  args: string[];
}

const PACKAGE_MANAGERS = new Set<PackageManagerName>([
  "npm",
  "pnpm",
  "yarn",
  "bun",
]);

function parsePackageManager(value: unknown): PackageManagerInfo | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([^@\s]+)@(.+)$/);
  if (!match || !PACKAGE_MANAGERS.has(match[1] as PackageManagerName)) {
    return null;
  }
  return { name: match[1] as PackageManagerName, version: match[2] };
}

export function detectPackageManager(
  root: string,
  packageManagerField?: unknown
): PackageManagerInfo {
  let declared = parsePackageManager(packageManagerField);
  if (!declared) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      declared = parsePackageManager(pkg?.packageManager);
    } catch {
      // lockfile detection below remains available for malformed/missing package.json
    }
  }
  if (declared) return declared;

  if (existsSync(join(root, "pnpm-lock.yaml"))) return { name: "pnpm" };
  if (existsSync(join(root, "yarn.lock"))) return { name: "yarn" };
  if (
    existsSync(join(root, "bun.lock")) ||
    existsSync(join(root, "bun.lockb"))
  ) {
    return { name: "bun" };
  }
  return { name: "npm" };
}

export function packageBinaryPlan(
  packageManager: PackageManagerName,
  binary: string,
  args: string[]
): CommandPlan {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["exec", binary, ...args] };
    case "yarn":
      return { command: "yarn", args: ["exec", binary, ...args] };
    case "bun":
      return { command: "bunx", args: [binary, ...args] };
    default:
      return { command: "npx", args: [binary, ...args] };
  }
}

export function packageScriptPlan(
  packageManager: PackageManagerName,
  script: string
): CommandPlan {
  return { command: packageManager, args: ["run", script] };
}

function yarnMajor(version?: string): number | null {
  const major = Number.parseInt(version?.match(/^\d+/)?.[0] ?? "", 10);
  return Number.isInteger(major) ? major : null;
}

export function packageInstallPlan(info: PackageManagerInfo): CommandPlan {
  if (info.name === "yarn" && (yarnMajor(info.version) ?? 1) >= 2) {
    return { command: "yarn", args: ["install", "--mode=skip-build"] };
  }
  if (info.name === "pnpm") {
    // .pnpmfile.cjs は install 時に任意コードを実行できるため、lifecycle script と同様に無効化する。
    return { command: "pnpm", args: ["install", "--ignore-scripts", "--ignore-pnpmfile"] };
  }
  return { command: info.name, args: ["install", "--ignore-scripts"] };
}

export function hasInstalledDependencies(
  root: string,
  packageManager: PackageManagerName
): boolean {
  if (existsSync(join(root, "node_modules"))) return true;
  return (
    packageManager === "yarn" &&
    (existsSync(join(root, ".pnp.cjs")) || existsSync(join(root, ".pnp.js")))
  );
}

const WINDOWS_COMMAND_SHIMS = new Set([
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "bun",
  "bunx",
]);

function commandBase(command: string): string {
  return command
    .replace(/^.*[\\/]/, "")
    .replace(/\.(?:cmd|bat|ps1|exe)$/i, "")
    .toLowerCase();
}

function quoteCmdToken(token: string): string {
  if (/^[A-Za-z0-9_@+=:,./\\-]+$/.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  shell: boolean;
  detached: boolean;
  windowsVerbatimArguments?: true;
}

/**
 * 拡張子なしのコマンド名(`mvn`、`composer` など)が Windows の PATH 上で .cmd/.bat に解決されるなら、その絶対パスを返す。
 * spawn は PATHEXT のうち .com/.exe しか補わないため、バッチの実体は cmd.exe 経由でないと ENOENT になる。
 * 絶対パスを返すのは、cmd.exe がカレントディレクトリ(開いたリポジトリ)を PATH より先に探すため。
 * PATH の各要素で PATHEXT の順に探し、最初に見つかった実体の拡張子で判定する。
 */
function resolveWindowsBatch(
  command: string,
  env: { PATH?: string; Path?: string; PATHEXT?: string }
): string | null {
  if (/[\\/]/.test(command) || /\.[^.\\/]+$/.test(command)) return null;
  let extensions = (env.PATHEXT ?? "")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  if (!extensions.length) extensions = [".COM", ".EXE", ".BAT", ".CMD"];
  for (const rawDirectory of (env.PATH ?? env.Path ?? "").split(";")) {
    // PATH の要素は "C:\Program Files\x" のように引用符で囲まれていることがある。
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, "$1");
    // 相対要素(`.` など)は cmd.exe が子の cwd = 開いたリポジトリ基準で解決するため探さない。
    if (!directory || !isAbsolute(directory)) continue;
    for (const ext of extensions) {
      // Windows のファイル名は大文字小文字を区別しない。PATHEXT は大文字なので小文字形も試す。
      const path = [ext, ext.toLowerCase()]
        .map((suffix) => join(directory, command + suffix))
        .find((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
      if (path) return /^\.(?:cmd|bat)$/i.test(ext) ? path : null;
    }
  }
  return null;
}

/** cmd.exe は引用符の中でも %VAR% を展開し、改行で行を区切る。安全に表現できない引数は拒否する。 */
function assertCmdSafeArgs(tokens: string[]): void {
  const unsafe = tokens.find((token) => /[%\r\n\0]/.test(token));
  if (unsafe !== undefined) {
    throw new Error(
      `cmd.exe 経由の起動では %・改行・NUL を含む引数を安全に渡せません: ${JSON.stringify(unsafe)}`
    );
  }
}

export function prepareCommandInvocation(
  command: string,
  args: string[],
  options: {
    shell?: boolean;
    detached?: boolean;
    platform?: NodeJS.Platform;
    comspec?: string;
    env?: { PATH?: string; Path?: string; PATHEXT?: string };
  } = {}
): CommandInvocation {
  const platform = options.platform ?? process.platform;
  // Without a console, cmd.exe can drop stdio for commands launched by a batch shim.
  // Windows tree cleanup uses taskkill, so only POSIX needs a detached process group.
  const detached = platform !== "win32" && options.detached === true;
  if (options.shell) return { command, args, shell: true, detached };

  const isKnownBatch =
    platform === "win32" &&
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- 固定の拡張子照合で量指定子なし
    (WINDOWS_COMMAND_SHIMS.has(commandBase(command)) || /\.(?:cmd|bat)$/i.test(command));
  const resolvedBatch =
    platform === "win32" && !isKnownBatch ? resolveWindowsBatch(command, options.env ?? process.env) : null;
  if (isKnownBatch || resolvedBatch) {
    const executable = resolvedBatch ?? command;
    assertCmdSafeArgs([executable, ...args]);
    const commandLine = [executable, ...args].map(quoteCmdToken).join(" ");
    return {
      command: options.comspec || process.env.ComSpec || "cmd.exe",
      // cmd /s strips the outer quotes. Pass the inner token quotes verbatim.
      args: ["/d", "/s", "/c", `"${commandLine}"`],
      shell: false,
      detached,
      windowsVerbatimArguments: true,
    };
  }

  return { command, args, shell: false, detached };
}
