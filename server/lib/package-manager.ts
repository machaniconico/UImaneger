import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
}

export function prepareCommandInvocation(
  command: string,
  args: string[],
  options: {
    shell?: boolean;
    platform?: NodeJS.Platform;
    comspec?: string;
  } = {}
): CommandInvocation {
  if (options.shell) return { command, args, shell: true };

  const platform = options.platform ?? process.platform;
  if (
    platform === "win32" &&
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- 固定の拡張子照合で量指定子なし
    (WINDOWS_COMMAND_SHIMS.has(commandBase(command)) || /\.(?:cmd|bat)$/i.test(command))
  ) {
    const commandLine = [command, ...args].map(quoteCmdToken).join(" ");
    return {
      command: options.comspec || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", commandLine],
      shell: false,
    };
  }

  return { command, args, shell: false };
}
