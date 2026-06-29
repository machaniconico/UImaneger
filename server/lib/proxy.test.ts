// ラウンド3: バックエンド ライフサイクル統合テスト (proxy)
// 対象: ProxyHandle.close の永久ハング修正の回帰
// 実 http サーバ・実ポートを使う node 環境テスト。
import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { findFreePort, isListening, sleep } from "./runner.ts";
import { startProxy, type ProxyHandle } from "./proxy.ts";

// --- helpers (自己完結) ---

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

function upgradeViaProxy(proxyPort: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: proxyPort });
    let settled = false;
    let raw = "";

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("data", onData);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(socket);
      }
    };
    const onError = (err: Error) => finish(err);
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (!raw.includes("\r\n\r\n")) return;
      if (!/^HTTP\/1\.1 101\b/.test(raw)) {
        finish(new Error(`unexpected upgrade response: ${raw}`));
        return;
      }
      finish();
    };
    const timer = setTimeout(
      () => finish(new Error("timed out waiting for websocket upgrade")),
      2_000
    );

    socket.on("error", onError);
    socket.on("data", onData);
    socket.on("connect", () => {
      socket.write(
        [
          "GET /hmr HTTP/1.1",
          `Host: 127.0.0.1:${proxyPort}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n")
      );
    });
  });
}

// --- ProxyHandle.close ---

const describeIfLoopback = (await canBindLoopback()) ? describe : describe.skip;

describeIfLoopback("ProxyHandle.close", () => {
  it("resolves within ~3s even with a lingering keep-alive connection to the proxy", async () => {
    // 小さな upstream http サーバを起動
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello from upstream");
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");

    // プロキシポートは findFreePort で動的取得(固定値回避)
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    try {
      handle = await startProxy(upstreamPort, proxyPort);

      // プロキシへリクエストを送り response を受け取る(プロキシ動作確認)
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: "/",
            agent,
          },
          (res) => {
            res.on("data", () => {});
            res.on("end", () => resolve());
          }
        );
        req.on("error", reject);
        req.end();
      });
      // この時点で keep-alive socket が agent に残存 = プロキシの接続が残っている

      // 接続を残したまま close() — タイムアウト(4s) 内に resolve すること
      const start = Date.now();
      await handle.close();
      const elapsed = Date.now() - start;
      // 永久ハング修正の回帰: 例えば3秒以内に resolve
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      agent.destroy();
      if (handle) {
        // 二重 close は安全(noop)であることを期待しつつ await
        await handle.close().catch(() => {});
      }
      await closeServer(upstream).catch(() => {});
    }

    // close 後にプロキシポートが解放されている(再 listen 可能 / isListening false)
    const released = await waitUntilFalse(
      () => isListening(proxyPort),
      3_000
    );
    expect(released).toBe(true);
    expect(await isListening(proxyPort)).toBe(false);
  }, 20_000);

  it("resolves promptly and releases the port with an open websocket upgrade connection", async () => {
    const upstreamSockets = new Set<net.Socket>();
    const upstream = http.createServer();
    upstream.on("connection", (socket) => {
      upstreamSockets.add(socket);
      socket.once("close", () => upstreamSockets.delete(socket));
    });
    upstream.on("upgrade", (_req, socket) => {
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "",
          "",
        ].join("\r\n")
      );
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    let client: net.Socket | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      client = await upgradeViaProxy(proxyPort);
      expect(client.destroyed).toBe(false);

      const start = Date.now();
      await handle.close();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      client?.destroy();
      for (const socket of upstreamSockets) {
        socket.destroy();
      }
      if (handle) {
        await handle.close().catch(() => {});
      }
      await closeServer(upstream).catch(() => {});
    }

    const released = await waitUntilFalse(
      () => isListening(proxyPort),
      3_000
    );
    expect(released).toBe(true);
    expect(await isListening(proxyPort)).toBe(false);
  }, 20_000);
});
