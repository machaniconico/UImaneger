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
    ]);
  });
});

describe("prepareCommandInvocation", () => {
  it("routes Windows command shims through cmd.exe without shell:true args", () => {
    expect(
      prepareCommandInvocation("npx", ["vite", "--port", "5180"], {
        platform: "win32",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      })
    ).toEqual({
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", "npx vite --port 5180"],
      shell: false,
    });
  });

  it("keeps native commands direct", () => {
    expect(
      prepareCommandInvocation("python", ["manage.py"], { platform: "win32" })
    ).toEqual({ command: "python", args: ["manage.py"], shell: false });
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
