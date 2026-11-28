// @vitest-environment node
// R3 受け入れテスト(件4): atomicWrite の権限(mode 保持・umask 非依存・symlink 保持・残骸なし)。
// 基準: .omc/plans/r3-security-audit-acceptance.md 件4(実装者は編集禁止)
// mode 検査は POSIX のみ。umask を変えられない環境(worker thread 等)ではその部分だけ skip。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.ts";
import { __stores } from "../../server/routes/api.ts";
import { openProject, stopProject } from "../../server/lib/state.ts";

const claudeMock = vi.hoisted(() => ({ complete: vi.fn(), streamComplete: vi.fn() }));

vi.mock("../../server/lib/claude.ts", () => ({
  complete: claudeMock.complete,
  streamComplete: claudeMock.streamComplete,
  hasKey: () => true,
  stripCodeFence: (text: string) => text.trim(),
  TruncatedError: class TruncatedError extends Error {},
}));

const app = createApp({ production: false, useLogger: false, serverPort: 5174, clientPort: 5173 });

const C0 = "export const App = () => <div>C0</div>;";
const C1 = "export const App = () => <div>C1</div>;";
const isWin = process.platform === "win32";
// CI の skip ゲート対策: OS 条件付きの AC は条件を満たす時だけ登録する(対象外の環境ではレポートに現れない)。
const noop = (..._args: unknown[]): void => {};

const canSetUmask: boolean = (() => {
  try {
    const old = process.umask(0o022);
    process.umask(old);
    return true;
  } catch {
    return false;
  }
})();

/** umask を一時的に変えて fn を実行し、必ず元に戻す。 */
async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const old = process.umask(mask);
  try {
    return await fn();
  } finally {
    process.umask(old);
  }
}

let root = "";

beforeEach(async () => {
  claudeMock.complete.mockReset();
  claudeMock.streamComplete.mockReset();
  claudeMock.streamComplete.mockImplementation((prompt: string, opts: unknown, onProgress?: unknown) =>
    claudeMock.complete(prompt, opts, onProgress)
  );
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();
  root = realpathSync(mkdtempSync(join(tmpdir(), "uim-mode-")));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/App.tsx"), C0, "utf8");
  await openProject(root, { command: "echo test-server-ready" });
});

afterEach(async () => {
  __stores.proposalStore.clear();
  __stores.undoStack.splice(0);
  __stores.redoStack.splice(0);
  __stores.historyLog.splice(0);
  __stores.inFlight.clear();
  await stopProject();
  rmSync(root, { recursive: true, force: true });
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

// AC-4-1 / 4-4: POSIX かつ umask を変えられる環境のみ登録。AC-4-2 / 4-3: POSIX のみ。AC-4-5: win32 のみ。
const itPosixUmask = !isWin && canSetUmask ? it : noop;
const itPosix = !isWin ? it : noop;
const itWin32 = isWin ? it : noop;
const modeOf = (p: string): number => statSync(p).mode & 0o777;
const oct = (n: number): string => n.toString(8).padStart(4, "0");
const tmpLeftovers = (dir: string): string[] => readdirSync(dir).filter((n) => n.includes(".tmp-"));

describe("件4 atomicWrite mode", () => {
  itPosixUmask(
    "AC-4-1 files_write_preserves_existing_mode_independent_of_umask (POSIX のみ・umask 変更可のみ)",
    async () => {
      const f = join(root, "src/f.txt");
      for (const m of [0o600, 0o640, 0o644, 0o755]) {
        for (const u of [0o022, 0o000, 0o077]) {
          writeFileSync(f, "before", "utf8");
          chmodSync(f, m);
          const r = await withUmask(u, () => post("/api/files/write", { path: f, content: `after-${oct(m)}-${oct(u)}` }));
          const label = `mode=${oct(m)} umask=${oct(u)}`;
          expect(r.status, `${label} status`).toBe(200);
          expect(readFileSync(f, "utf8"), `${label} content`).toBe(`after-${oct(m)}-${oct(u)}`);
          expect(oct(modeOf(f)), `${label} mode`).toBe(oct(m));
        }
      }
    }
  );

  itPosix("AC-4-2 apply_undo_redo_preserve_mode (POSIX のみ)", async () => {
    const f = join(root, "src/App.tsx");
    for (const m of [0o600, 0o755]) {
      writeFileSync(f, C0, "utf8");
      chmodSync(f, m);
      __stores.undoStack.splice(0);
      __stores.redoStack.splice(0);
      claudeMock.complete.mockResolvedValueOnce(C1);
      const c = await post("/api/edit/candidate", { file: f, instruction: "Change the label." });
      expect(c.status, `candidate ${oct(m)}`).toBe(200);

      const ap = await post("/api/edit/apply", { proposalId: c.json.proposalId });
      expect(ap.status, `apply ${oct(m)}`).toBe(200);
      expect(readFileSync(f, "utf8")).toBe(C1);
      expect(oct(modeOf(f)), `apply 後 mode (orig ${oct(m)})`).toBe(oct(m));

      const un = await post("/api/edit/undo", {});
      expect(un.status, `undo ${oct(m)}`).toBe(200);
      expect(readFileSync(f, "utf8")).toBe(C0);
      expect(oct(modeOf(f)), `undo 後 mode (orig ${oct(m)})`).toBe(oct(m));

      const re = await post("/api/edit/redo", {});
      expect(re.status, `redo ${oct(m)}`).toBe(200);
      expect(readFileSync(f, "utf8")).toBe(C1);
      expect(oct(modeOf(f)), `redo 後 mode (orig ${oct(m)})`).toBe(oct(m));
    }
  });

  itPosix("AC-4-3 write_through_symlink_keeps_link_and_target_mode (POSIX のみ)", async () => {
    mkdirSync(join(root, "real"), { recursive: true });
    const target = join(root, "real/target.txt");
    const alias = join(root, "src/alias.txt");
    writeFileSync(target, "target-before", "utf8");
    chmodSync(target, 0o600);
    symlinkSync("../real/target.txt", alias);

    const r = await post("/api/files/write", { path: alias, content: "target-after" });
    expect(r.status).toBe(200);
    expect(lstatSync(alias).isSymbolicLink(), "alias が symlink のまま").toBe(true);
    expect(readFileSync(target, "utf8")).toBe("target-after");
    expect(oct(modeOf(target)), "target の mode").toBe("0600");
  });

  itPosixUmask(
    "AC-4-4 new_file_uses_umask_default_and_no_temp_files_remain (POSIX のみ・umask 変更可のみ)",
    async () => {
      // (a) 未存在ファイル: 0666 & ~umask
      for (const [u, expected] of [
        [0o022, "0644"],
        [0o077, "0600"],
      ] as const) {
        const f = join(root, "src", `new-${oct(u)}.txt`);
        const r = await withUmask(u, () => post("/api/files/write", { path: f, content: "fresh" }));
        expect(r.status, `new file umask=${oct(u)}`).toBe(200);
        expect(readFileSync(f, "utf8")).toBe("fresh");
        expect(oct(modeOf(f)), `new file mode umask=${oct(u)}`).toBe(expected);
      }
      expect(tmpLeftovers(join(root, "src")), "(a) 後の .tmp- 残骸").toEqual([]);

      // (b) 既存ディレクトリを path に指定
      mkdirSync(join(root, "src/dir"), { recursive: true });
      const r = await post("/api/files/write", { path: join(root, "src/dir"), content: "x" });
      expect(r.status >= 200 && r.status < 300, `dir への write が ${r.status}`).toBe(false);
      expect(statSync(join(root, "src/dir")).isDirectory(), "src/dir がディレクトリのまま").toBe(true);
      expect(tmpLeftovers(join(root, "src")), "(b) 後の .tmp- 残骸").toEqual([]);
    }
  );

  // win32 のみ: Windows は mode 保持対象外。読み取り専用は失敗・不変・残骸なし。Linux では skip。
  itWin32("AC-4-5 windows_write_succeeds_and_readonly_file_fails_cleanly (win32 only)", async () => {
    const dir = join(root, "src");
    const ok = join(dir, "plain.txt");
    writeFileSync(ok, "before", "utf8");
    const a = await post("/api/files/write", { path: ok, content: "after" });
    expect(a.status).toBe(200);
    expect(readFileSync(ok, "utf8")).toBe("after");

    const ro = join(dir, "readonly.txt");
    writeFileSync(ro, "locked", "utf8");
    chmodSync(ro, 0o444);
    try {
      const b = await post("/api/files/write", { path: ro, content: "changed" });
      expect(b.status >= 200 && b.status < 300, `readonly write が ${b.status}`).toBe(false);
      expect(readFileSync(ro, "utf8")).toBe("locked");
    } finally {
      chmodSync(ro, 0o666);
    }
    expect(tmpLeftovers(dir)).toEqual([]);
  });
});
