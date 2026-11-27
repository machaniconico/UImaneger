import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectPackageManager,
  hasInstalledDependencies,
  packageBinaryPlan,
  packageInstallPlan,
  packageScriptPlan,
  prepareCommandInvocation,
} from "./package-manager.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "uim-pm-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

describe("detectPackageManager", () => {
  it("prefers package.json packageManager over lockfiles", () => {
    const root = tempDir();
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");
    expect(detectPackageManager(root, "yarn@4.6.0")).toEqual({
      name: "yarn",
      version: "4.6.0",
    });
  });

  it.each([
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as const)("detects %s", (lockfile, expected) => {
    const root = tempDir();
    writeFileSync(join(root, lockfile), "");
    expect(detectPackageManager(root).name).toBe(expected);
  });
});

describe("package manager command plans", () => {
  it("uses each package manager's project binary command", () => {
    expect(packageBinaryPlan("npm", "vite", ["--port", "5180"])).toEqual({
      command: "npx",
      args: ["vite", "--port", "5180"],
    });
    expect(packageBinaryPlan("pnpm", "vite", [])).toEqual({
      command: "pnpm",
      args: ["exec", "vite"],
    });
    expect(packageBinaryPlan("yarn", "vite", [])).toEqual({
      command: "yarn",
      args: ["exec", "vite"],
    });
    expect(packageBinaryPlan("bun", "vite", [])).toEqual({
      command: "bunx",
      args: ["vite"],
    });
  });

  it("runs generic scripts with the selected package manager", () => {
    expect(packageScriptPlan("pnpm", "dev")).toEqual({
      command: "pnpm",
      args: ["run", "dev"],
    });
  });

  it("uses skip-build for modern Yarn and ignore-scripts elsewhere", () => {
    expect(packageInstallPlan({ name: "yarn", version: "4.6.0" }).args).toEqual([
      "install",
      "--mode=skip-build",
    ]);
    expect(packageInstallPlan({ name: "pnpm" }).args).toEqual([
      "install",
      "--ignore-scripts",
      "--ignore-pnpmfile",
    ]);
    expect(packageInstallPlan({ name: "npm" }).args).toEqual(["install", "--ignore-scripts"]);
    expect(packageInstallPlan({ name: "bun" }).args).toEqual(["install", "--ignore-scripts"]);
  });
});

describe("prepareCommandInvocation", () => {
  it("keeps Windows npm dev output attached", () => {
    expect(prepareCommandInvocation("npm", ["run", "dev"], {
      platform: "win32",
      detached: true,
    })).toMatchObject({ shell: false, detached: false });
  });

  it("keeps Windows npm JSON output attached", () => {
    expect(prepareCommandInvocation("npm", ["ls", "--depth=0", "--json"], {
      platform: "win32",
      detached: true,
    })).toMatchObject({ shell: false, detached: false });
  });

  it("passes a verbatim cmd command line with a spaced shim path", () => {
    expect(
      prepareCommandInvocation("C:\\Program Files\\nodejs\\npx.cmd", ["vite", "--port", "5180"], {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      })
    ).toMatchObject({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\npx.cmd" vite --port 5180"'],
      shell: false,
      windowsVerbatimArguments: true,
    });
  });

  it("keeps the detached process group on Linux", () => {
    expect(prepareCommandInvocation("npm", ["run", "dev"], {
      platform: "linux",
      detached: true,
    })).toMatchObject({ command: "npm", args: ["run", "dev"], shell: false, detached: true });
  });

  it("keeps native commands direct", () => {
    expect(
      prepareCommandInvocation("python", ["manage.py"], { platform: "win32" })
    ).toEqual({ command: "python", args: ["manage.py"], shell: false, detached: false });
  });
});

describe("hasInstalledDependencies", () => {
  it("recognizes Yarn Plug'n'Play installs", () => {
    const root = tempDir();
    writeFileSync(join(root, ".pnp.cjs"), "module.exports = {};");
    expect(hasInstalledDependencies(root, "yarn")).toBe(true);
    expect(hasInstalledDependencies(root, "npm")).toBe(false);
  });
});
