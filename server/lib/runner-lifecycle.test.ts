// ラウンド3: バックエンド ライフサイクル統合テスト (runner)
// 対象: isListening / startTarget(プロセス起動) / findFreePort
// 実プロセス・実ポートを使う node 環境テスト。jsdom 不要。
import { describe, it, expect } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isListening,
  findFreePort,
  startTarget,
  sleep,
  killAllChildrenSync,
} from "./runner.ts";

// --- helpers (自己完結。各テストファイルで独立定義) ---

function listenOnFreePort(server: http.Server, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("error", onError);
      reject(err);
    };
    server.on("error", onError);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object" && typeof addr.port === "number") {
        server.off("error", onError);
        resolve(addr.port);
      } else {
        server.off("error", onError);
        reject(new Error("listen did not yield a port"));
      }
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function canBindLoopback(): Promise<boolean> {
  const server = http.createServer();
  try {
    await listenOnFreePort(server, "127.0.0.1");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  } finally {
    await closeServer(server).catch(() => {});
  }
}

/** fn() が false を返すまでポーリング。timeout 内に false になれば true。 */
async function waitUntilFalse(
  fn: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fn())) return true;
    await sleep(50);
  }
  return false;
}

// --- isListening ---

const hasLoopback = await canBindLoopback();
const describeIfLoopback = hasLoopback ? describe : describe.skip;
const itIfLoopback = hasLoopback ? it : it.skip;

describeIfLoopback("isListening", () => {
  it("detects a listening IPv4 (127.0.0.1) port and returns false after close", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    const port = await listenOnFreePort(server, "127.0.0.1");
    try {
      expect(await isListening(port)).toBe(true);
    } finally {
      await closeServer(server);
    }
    // 閉じた後は false になるまでポーリング(固定 sleep 決め打ち回避)
    const closed = await waitUntilFalse(() => isListening(port), 3_000);
    expect(closed).toBe(true);
    expect(await isListening(port)).toBe(false);
  }, 15_000);

  it("detects an IPv6-only (::1) server (or logs+skips when IPv6 bind is unavailable)", async (ctx) => {
    const server = http.createServer((_req, res) => res.end("ok"));
    let port: number | null = null;
    try {
      // server.listen(0, "::1") — IPv6 非対応ホストでは EADDRNOTAVAIL/EAFNOSUPPORT
      port = await listenOnFreePort(server, "::1");
      const p = port; // number に確定(クロージャ内での number|null 復帰を回避)
      expect(await isListening(p)).toBe(true);
      await closeServer(server);
      const closed = await waitUntilFalse(() => isListening(p), 3_000);
      expect(closed).toBe(true);
      expect(await isListening(p)).toBe(false);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (
        err.code === "EADDRNOTAVAIL" ||
        err.code === "EAFNOSUPPORT" ||
        err.code === "EPERM"
      ) {
        // silent pass にしない: スキップ理由をログ出力
        console.log(
          `[skip] IPv6 (::1) bind is not available on this host: ${err.message}`
        );
        ctx.skip();
        return;
      }
      throw e;
    } finally {
      if (port === null) {
        try {
          await closeServer(server);
        } catch {
          // best effort
        }
      }
    }
  }, 15_000);
});

// --- findFreePort ---

describeIfLoopback("findFreePort", () => {
  it("returns a free integer port at or after the start value", async () => {
    const port = await findFreePort(50_000);
    expect(Number.isInteger(port)).toBe(true);
    expect(port).toBeGreaterThanOrEqual(50_000);
    expect(port).toBeLessThanOrEqual(65_535);
  }, 10_000);

  it("skips a port that is in use on IPv4 and returns a higher free one", async () => {
    const blocker = http.createServer((_req, res) => res.end());
    const blockedPort = await listenOnFreePort(blocker, "127.0.0.1");
    try {
      const next = await findFreePort(blockedPort);
      expect(next).not.toBe(blockedPort);
      expect(next).toBeGreaterThan(blockedPort);
    } finally {
      await closeServer(blocker);
    }
  }, 10_000);
});

// --- startTarget ---

describe("startTarget", () => {
  it("rejects within seconds (not 60s) when the run command does not exist", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "uim-runner-"));
    try {
      const start = Date.now();
      // runCommand (override.command) に存在しないコマンドを渡す。
      // sh -c 経由で即座に exit 127 し、startTarget は明確なエラーで reject する
      // (spawn 'error' 未処理クラッシュ修正の回帰: プロセスがハング/クラッシュしない)。
      await expect(
        startTarget(tmp, 0, {
          command: "this-command-does-not-exist-xyz",
        })
      ).rejects.toThrow(/(exit|起動に失敗|起動できません)/);
      const elapsed = Date.now() - start;
      // 60秒待たず数秒以内に reject されること
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("rejects promptly when direct spawn fails with ENOENT", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "uim-runner-enoent-"));
    const oldPath = process.env.PATH;
    try {
      writeFileSync(
        join(tmp, "package.json"),
        JSON.stringify({ dependencies: { next: "14.0.0" } })
      );
      process.env.PATH = join(tmp, "missing-bin");

      const start = Date.now();
      await expect(startTarget(tmp, 3000)).rejects.toThrow(/起動できません/);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      if (oldPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = oldPath;
      }
      killAllChildrenSync();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  itIfLoopback("killAllChildrenSync kills a live detached target registered by startTarget", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "uim-runner-live-"));
    try {
      const target = await startTarget(tmp, 0, {
        command:
          "node -e \"require('http').createServer((_req,res)=>res.end('ok')).listen(0,'127.0.0.1',function(){console.log('Listening on '+this.address().port)})\"",
      });
      expect(await isListening(target.port)).toBe(true);

      killAllChildrenSync();

      const closed = await waitUntilFalse(
        () => isListening(target.port),
        3_000
      );
      expect(closed).toBe(true);
    } finally {
      killAllChildrenSync();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 15_000);
});
