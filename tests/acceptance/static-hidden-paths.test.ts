// @vitest-environment node
// R3 受け入れテスト(件1): Static 配信の隠し名迂回(server/static-server.mjs)。
// 基準: .omc/plans/r3-security-audit-acceptance.md 件1(実装者は編集禁止)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = resolve(here, "../../server/static-server.mjs");

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const p = typeof a === "object" && a ? a.port : 0;
      s.close(() => res(p));
    });
  });
}

async function canBindLoopback(): Promise<boolean> {
  try {
    await freePort();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  }
}

const hasLoopback = await canBindLoopback();

// CI の「Acceptance tests must not be skipped」ゲートは skipped/pending を 1 件も許さない。
// OS・FS 条件付きの AC は skipIf ではなく、条件を満たす時だけ登録する(対象外の環境ではレポートに現れない)。
const noop = (..._args: unknown[]): void => {};
// win32 のみの AC-1-7 は Linux / macOS では登録されない(対象外)。
const itWin32 = process.platform === "win32" ? it : noop;
// symlink を作れない環境(win32 EPERM)では AC-1-4 は登録されない(対象外)。
const canSymlink: boolean = (() => {
  const d = mkdtempSync(join(tmpdir(), "uim-symprobe-"));
  try {
    symlinkSync("a", join(d, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
})();
const itSymlink = canSymlink ? it : noop;

let fixtureRoot = "";
let port = 0;
let child: ChildProcess | undefined;
let symlinksOk = true;

function put(rel: string, content: string): void {
  const p = join(fixtureRoot, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

interface Raw {
  status: number;
  body: string;
}

/** 生の request-target をそのまま送る(fetch/URL は正規化するので使わない)。 */
function raw(path: string, method: "GET" | "HEAD" = "GET"): Promise<Raw> {
  return new Promise((res, rej) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, agent: false },
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () =>
          res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("error", rej);
    req.end();
  });
}

/** 「拒否」= status 404 かつ本文に SECRET_ なし。 */
async function expectRejected(path: string, method: "GET" | "HEAD" = "GET"): Promise<void> {
  const r = await raw(path, method);
  expect(r.status, `${method} ${path} status (body=${r.body.slice(0, 40)})`).toBe(404);
  expect(r.body, `${method} ${path} body`).not.toContain("SECRET_");
}

async function expectServed(path: string, status: number, body: string): Promise<void> {
  const r = await raw(path);
  expect(r.status, `GET ${path} status`).toBe(status);
  expect(r.body, `GET ${path} body`).toBe(body);
}

beforeAll(async () => {
  if (!hasLoopback) return;
  fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "uim-static-")));
  put("index.html", "INDEX_OK");
  put("sub/page.html", "PAGE_OK");
  put("sub/v1.2/app.min.js", "JS_OK");
  put("sub/日本.html", "JP_OK");
  put(".env", "SECRET_ROOT_ENV");
  put("sub/.env", "SECRET_SUB_ENV");
  put(".git/config", "SECRET_GIT_CONFIG");
  put("node_modules/pkg/index.js", "SECRET_NM");
  put(".well-known/security.txt", "WELLKNOWN_OK");
  put(".well-known/.hidden", "SECRET_WK");
  mkdirSync(join(fixtureRoot, "public"), { recursive: true });
  try {
    symlinkSync("../.env", join(fixtureRoot, "public/link-env"));
    symlinkSync("../.git", join(fixtureRoot, "public/link-git"));
    symlinkSync("../node_modules", join(fixtureRoot, "public/link-nm"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    symlinksOk = false;
  }

  port = await freePort();
  child = spawn(process.execPath, [SERVER_SCRIPT, "--port", String(port)], {
    cwd: fixtureRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error("static-server did not start")), 10_000);
    child!.stdout!.on("data", (d: Buffer) => {
      if (String(d).includes("listening")) {
        clearTimeout(timer);
        res();
      }
    });
    child!.once("exit", (code) => {
      clearTimeout(timer);
      rej(new Error(`static-server exited early: ${code}`));
    });
  });
}, 20_000);

afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((res) => child!.once("exit", () => res()));
    child.kill("SIGKILL");
    await exited;
  }
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

// loopback を bind できない環境ではこのファイルの AC は登録されない(対象外)。
if (hasLoopback) describe("件1 static hidden paths", () => {
  it("AC-1-1 static_rejects_backslash_separated_paths_to_hidden_files", async () => {
    const paths = [
      "/%5C.env",
      "/sub%5C.env",
      "/sub%5c.env",
      "/sub%5C..%5C.env",
      "/%5C.git%5Cconfig",
      "/.git%5Cconfig",
      "/\\.env",
      "/sub\\.env",
    ];
    for (const method of ["GET", "HEAD"] as const) {
      for (const p of paths) await expectRejected(p, method);
    }
  });

  it("AC-1-2 static_rejects_encoded_slash_double_slash_and_dot_segment_variants", async () => {
    const paths = [
      "/.env",
      "/%2Eenv",
      "/%2eenv",
      "/sub%2F.env",
      "/sub%2f.env",
      "/sub//.env",
      "//.env",
      "///sub///.env",
      "/./.env",
      "/sub/./.env",
      "/sub/x/../.env",
      "/sub/%2E%2E/.env",
      "/sub/..%2F.env",
      "/%2Egit/config",
      "/.git%2Fconfig",
    ];
    for (const p of paths) await expectRejected(p);
  });

  it("AC-1-3 static_rejects_node_modules_in_any_separator_or_case_form", async () => {
    const paths = [
      "/node_modules/pkg/index.js",
      "/%5Cnode_modules/pkg/index.js",
      "/node_modules%5Cpkg%5Cindex.js",
      "/node_modules%2Fpkg%2Findex.js",
      "/sub/..%5Cnode_modules/pkg/index.js",
      "/NODE_MODULES/pkg/index.js",
      "/Node_Modules%5Cpkg%5Cindex.js",
    ];
    for (const p of paths) await expectRejected(p);
  });

  itSymlink("AC-1-4 static_rejects_symlink_that_resolves_to_hidden_or_node_modules", async () => {
    expect(symlinksOk, "fixture の symlink 作成").toBe(true);
    for (const p of ["/public/link-env", "/public/link-git/config", "/public/link-nm/pkg/index.js"]) {
      await expectRejected(p);
    }
  });

  it("AC-1-5 static_rejects_nul_malformed_and_double_encoded_paths", async () => {
    for (const p of ["/.env%00", "/sub/page.html%00.env", "/%252Eenv", "/sub%255C.env", "/sub%252F.env"]) {
      await expectRejected(p);
    }
    for (const p of ["/%E0%A4%A", "/%"]) {
      const r = await raw(p);
      expect(r.status, `GET ${p} status`).toBe(400);
    }
  });

  it("AC-1-6 static_serves_regular_files_and_well_known_after_normalization", async () => {
    await expectServed("/", 200, "INDEX_OK");
    for (const p of [
      "/sub/page.html",
      "/sub/%70age.html",
      "/sub/../sub/page.html",
      "/sub/page.html?next=/.env&x=%5C.env",
    ]) {
      await expectServed(p, 200, "PAGE_OK");
    }
    await expectServed("/sub/v1.2/app.min.js", 200, "JS_OK");
    await expectServed("/sub/%E6%97%A5%E6%9C%AC.html", 200, "JP_OK");
    await expectServed("/.well-known/security.txt", 200, "WELLKNOWN_OK");
    const hidden = await raw("/.well-known/.hidden");
    expect(hidden.status).toBe(404);
    expect(hidden.body).not.toContain("SECRET_");
    expect((await raw("/sub%5Cpage.html")).status).toBe(404);
  });

  // win32 のみ: Windows の名前別名(末尾ドット・空白・ADS・8.3)。他 OS では登録されない。
  itWin32(
    "AC-1-7 static_rejects_windows_name_aliases (win32 only)",
    async () => {
      const paths = [
        "/node_modules./pkg/index.js",
        "/node_modules%20/pkg/index.js",
        "/node_modules::$INDEX_ALLOCATION/pkg/index.js",
        "/sub/.env::$DATA",
        "/sub/..%5C..%5C..%5CWindows/win.ini",
        "/C:%5CWindows%5Cwin.ini",
      ];
      // 8.3 名がある時のみ
      if (existsSync(join(fixtureRoot, "GIT~1", "config"))) paths.push("/GIT~1/config");
      if (existsSync(join(fixtureRoot, "NODE_M~1", "pkg", "index.js"))) paths.push("/NODE_M~1/pkg/index.js");
      for (const p of paths) await expectRejected(p);
    }
  );
});