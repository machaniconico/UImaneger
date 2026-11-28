// @vitest-environment node
// R3 受け入れテスト: /api/files/read・/api/files/write の削除(AC-6-1〜6-3、全 OS で登録)。
// 基準: .omc/plans/r3-remove-files-api-acceptance.md(実装者は編集禁止)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../server/app.ts";
import { openProject, stopProject } from "../../server/lib/state.ts";

const app = createApp({ production: false, useLogger: false, serverPort: 5174, clientPort: 5173 });

const MARKER = "MARKER_FILES_API_REMOVED";
const APP_SRC = `export const App = () => <div>${MARKER}</div>;`;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

let root = "";
const extra: string[] = [];

function mkTmp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  extra.push(d);
  return d;
}

beforeEach(async () => {
  root = mkTmp("uim-files-removed-");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/App.tsx"), APP_SRC, "utf8");
  await openProject(root, { command: "echo test-server-ready" });
});

afterEach(async () => {
  await stopProject();
  for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sendBody = (m: string): boolean => m !== "GET" && m !== "HEAD" && m !== "OPTIONS";

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
  const init: RequestInit = { method };
  if (sendBody(method)) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await app.request(path, init);
  return { status: res.status, text: await res.text() };
}

describe("件6 files API 削除", () => {
  it("AC-6-1 removed_files_read_is_404_for_every_method_and_returns_no_content", async () => {
    const abs = join(root, "src/App.tsx");
    const paths = [`/api/files/read?path=${encodeURIComponent(abs)}`, "/api/files/read/", "/api/files"];
    const check = async (label: string) => {
      for (const path of paths) {
        for (const method of METHODS) {
          const r = await call(method, path, { path: abs });
          expect(r.status, `${label} ${method} ${path}`).toBe(404);
          expect(r.text, `${label} ${method} ${path} 本文`).not.toContain(MARKER);
        }
      }
    };
    await check("open");
    await stopProject();
    await check("no-project");
  });

  it("AC-6-2 removed_files_write_is_404_and_never_creates_or_modifies_files", async () => {
    const existing = join(root, "src/App.tsx");
    const fresh = join(root, "src/brand-new.txt");
    chmodSync(existing, 0o640);
    const modeBefore = statSync(existing).mode & 0o777;
    const entriesBefore = readdirSync(join(root, "src")).sort();
    const check = async (label: string) => {
      for (const target of [existing, fresh]) {
        for (const method of METHODS) {
          const r = await call(method, "/api/files/write", { path: target, content: "OVERWRITTEN" });
          expect(r.status, `${label} ${method} ${target}`).toBe(404);
        }
      }
      expect(readFileSync(existing, "utf8"), `${label} 既存内容`).toBe(APP_SRC);
      expect(statSync(existing).mode & 0o777, `${label} 既存 mode`).toBe(modeBefore);
      expect(existsSync(fresh), `${label} 新規パスが作られた`).toBe(false);
      expect(readdirSync(join(root, "src")).sort(), `${label} src/ エントリ集合`).toEqual(entriesBefore);
    };
    await check("open");
    await stopProject();
    await check("no-project");
  });

  it("AC-6-3 removed_files_routes_are_404_in_production_and_not_spa_fallback", async () => {
    const dist = mkTmp("uim-files-dist-");
    const SPA = "SPA_FALLBACK_MARKER_XYZ";
    writeFileSync(join(dist, "index.html"), `<!doctype html><html><body>${SPA}</body></html>`, "utf8");
    const prod = createApp({
      production: true,
      distRoot: dist,
      distExists: true,
      useLogger: false,
      serverPort: 5174,
      clientPort: 5173,
    });
    const html = { accept: "text/html" };
    const abs = join(root, "src/App.tsx");
    const reqs: Array<[string, string, RequestInit]> = [
      ["GET", `/api/files/read?path=${encodeURIComponent(abs)}`, { method: "GET", headers: html }],
      ["HEAD", `/api/files/read?path=${encodeURIComponent(abs)}`, { method: "HEAD", headers: html }],
      [
        "POST",
        "/api/files/write",
        {
          method: "POST",
          headers: { ...html, "content-type": "application/json" },
          body: JSON.stringify({ path: abs, content: "x" }),
        },
      ],
    ];
    for (const [label, path, init] of reqs) {
      const res = await prod.request(path, init);
      const text = await res.text();
      expect(res.status, `${label} ${path}`).toBe(404);
      expect(text, `${label} ${path} 本文`).not.toContain(SPA);
    }
    expect(readFileSync(abs, "utf8")).toBe(APP_SRC);
  });
});
