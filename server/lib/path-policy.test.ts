// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync as actualRealpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// realpathSync.native が指定パスで EACCES を投げる状況を作る(権限で解決できない別名)。
const failing = vi.hoisted(() => ({ path: "", code: "EACCES" }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const realpath = ((...args: Parameters<typeof actual.realpathSync>) =>
    actual.realpathSync(...args)) as typeof actual.realpathSync;
  realpath.native = ((p: Parameters<typeof actual.realpathSync.native>[0], o?: never) => {
    if (failing.path && String(p) === failing.path) {
      const err = new Error(`${failing.code}: mocked`) as NodeJS.ErrnoException;
      err.code = failing.code;
      throw err;
    }
    return actual.realpathSync.native(p, o);
  }) as typeof actual.realpathSync.native;
  return { ...actual, realpathSync: realpath, default: { ...actual, realpathSync: realpath } };
});

const { isInsideRoot, isProtectedPath } = await import("./path-policy.ts");

/** 編集 API が書き込みを許す条件(root 内かつ保護外)。 */
function allowed(root: string, file: string): boolean {
  return isInsideRoot(root, file) && !isProtectedPath(root, file);
}

let root = "";

beforeEach(() => {
  root = actualRealpathSync(mkdtempSync(join(tmpdir(), "uim-policy-")));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), "GIT", "utf8");
  writeFileSync(join(root, "src", "App.tsx"), "C0", "utf8");
});

afterEach(() => {
  failing.path = "";
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("path-policy fails closed when the target cannot be resolved", () => {
  it("rejects a target whose realpath fails with EACCES", () => {
    const link = join(root, "src", "link.tsx");
    symlinkSync("../.git/config", link);
    failing.path = link;
    expect(allowed(root, link)).toBe(false);
  });

  it("treats every target as protected when the root itself cannot be resolved", () => {
    failing.path = root;
    expect(isProtectedPath(root, join(root, "src", "App.tsx"))).toBe(true);
  });

  it("rejects a symlink loop (ELOOP)", () => {
    const loop = join(root, "src", "loop.tsx");
    symlinkSync("loop.tsx", loop);
    expect(allowed(root, loop)).toBe(false);
  });

  it("rejects a dangling symlink that points into a protected directory", () => {
    const dangling = join(root, "src", "dangling.tsx");
    symlinkSync("../.git/hooks-new", dangling);
    expect(allowed(root, dangling)).toBe(false);
  });

  it("still allows regular files and new files whose parent exists", () => {
    expect(allowed(root, join(root, "src", "App.tsx"))).toBe(true);
    expect(allowed(root, join(root, "src", "new.txt"))).toBe(true);
    expect(allowed(root, join(root, "src", "missing-dir", "new.txt"))).toBe(false);
  });
});
