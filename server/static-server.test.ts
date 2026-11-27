// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findFreePort } from "./lib/runner.ts";

const SERVER_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "static-server.mjs");

let child: ChildProcess | undefined;
let root = "";

afterEach(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((r) => child!.once("exit", () => r()));
    child.kill("SIGKILL");
    await exited;
  }
  child = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function get(port: number, path: string): Promise<number> {
  return new Promise((res) => {
    const req = http.get({ host: "127.0.0.1", port, path, agent: false }, (r) => {
      r.resume();
      r.on("end", () => res(r.statusCode ?? 0));
      r.on("error", () => res(0));
    });
    req.on("error", () => res(0));
  });
}

describe("static-server", () => {
  it("keeps running when a file disappears between the checks and the read", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "uim-static-race-")));
    const port = await findFreePort(39200);
    child = spawn(process.execPath, [SERVER_SCRIPT, "--port", String(port)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((res, rej) => {
      child!.stdout!.once("data", () => res());
      child!.once("exit", (code) => rej(new Error(`exited early: ${code}`)));
    });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });

    const file = join(root, "f.txt");
    let stop = false;
    const churn = (async () => {
      while (!stop) {
        try {
          writeFileSync(file, "x");
          unlinkSync(file);
        } catch {
          // 競合は想定内
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    const statuses = new Set<number>();
    for (let i = 0; i < 1500 && !exited; i++) statuses.add(await get(port, "/f.txt"));
    stop = true;
    await churn;

    expect(exited, "static-server が例外で終了した").toBe(false);
    for (const s of statuses) expect([200, 404]).toContain(s);
  }, 60_000);
});
