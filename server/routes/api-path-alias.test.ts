// @vitest-environment node
// Windows の 8.3 短縮名(C:\Users\RUNNER~1\...)の再現: fs.realpathSync(JS 実装)は短縮名を
// 展開せず、fs.realpathSync.native だけが長い名前に展開する。Linux では、root を symlink の
// 別名で渡し、JS 実装の realpathSync がその別名を解決しないようにモックして同じ食い違いを作る。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync as actualRealpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const alias = vi.hoisted(() => ({ short: "", long: "" }));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const jsRealpath = ((p: Parameters<typeof actual.realpathSync>[0], opts?: never) => {
    const s = String(p);
    if (alias.short && (s === alias.short || s.startsWith(alias.short + sep))) {
      // 実在は確認しつつ、別名は展開しない(Windows の JS 実装が 8.3 名を残すのと同じ)
      actual.statSync(s);
      return s;
    }
    return actual.realpathSync(p, opts);
  }) as typeof actual.realpathSync;
  jsRealpath.native = actual.realpathSync.native;
  return { ...actual, realpathSync: jsRealpath, default: { ...actual, realpathSync: jsRealpath } };
});

const { atomicWrite } = await import("./api.ts");
const { isProtectedPath } = await import("../lib/path-policy.ts");

let base = "";

beforeEach(() => {
  base = actualRealpathSync(mkdtempSync(join(tmpdir(), "uim-alias-")));
  alias.long = join(base, "runneradmin");
  alias.short = join(base, "RUNNER~1");
  mkdirSync(join(alias.long, "src"), { recursive: true });
  symlinkSync(alias.long, alias.short);
});

afterEach(() => {
  alias.short = "";
  alias.long = "";
  rmSync(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === "win32")("root given by a short-name alias", () => {
  it("writes an existing file under the aliased root", async () => {
    const file = join(alias.short, "src", "App.tsx");
    writeFileSync(file, "C0", "utf8");
    await atomicWrite(file, "C1", alias.short);
    expect(readFileSync(join(alias.long, "src", "App.tsx"), "utf8")).toBe("C1");
  });

  it("writes a new file under the aliased root", async () => {
    const file = join(alias.short, "src", "new.txt");
    await atomicWrite(file, "N", alias.short);
    expect(readFileSync(join(alias.long, "src", "new.txt"), "utf8")).toBe("N");
  });

  it("does not treat a normal file as protected and still protects .git", () => {
    expect(isProtectedPath(alias.short, join(alias.short, "src", "App.tsx"))).toBe(false);
    expect(isProtectedPath(alias.short, join(alias.long, "src", "App.tsx"))).toBe(false);
    expect(isProtectedPath(alias.short, join(alias.short, ".git", "config"))).toBe(true);
  });
});
