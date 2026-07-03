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

type ProxyTestResponse = {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

function requestViaProxy(
  proxyPort: number,
  path = "/"
): Promise<ProxyTestResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path,
      },
      (res) => {
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
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

describeIfLoopback("proxy transport fidelity", () => {
  it("rewrites target Location headers on the pipe response path", async () => {
    let upstreamPort = 0;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(302, {
        "content-type": "text/plain",
        location: `http://127.0.0.1:${upstreamPort}/next?from=target#frag`,
      });
      res.end("redirect");
    });
    upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        `http://127.0.0.1:${proxyPort}/next?from=target#frag`
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("rewrites target Location headers on the HTML response path", async () => {
    let upstreamPort = 0;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(302, {
        "content-type": "text/html; charset=utf-8",
        location: `http://127.0.0.1:${upstreamPort}/html-next`,
      });
      res.end("<!doctype html><html><body>redirect</body></html>");
    });
    upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      const body = response.body.toString("utf8");

      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(
        `http://127.0.0.1:${proxyPort}/html-next`
      );
      expect(body).toContain("data-uim-inspector");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("passes non-UTF-8 HTML through byte-identical without injection", async () => {
    const shiftJisBody = Buffer.concat([
      Buffer.from("<!doctype html><html><body>", "ascii"),
      Buffer.from([
        0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd,
      ]),
      Buffer.from("</body></html>", "ascii"),
    ]);
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=shift_jis",
        "content-length": String(shiftJisBody.byteLength),
      });
      res.end(shiftJisBody);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);

      expect(response.body.equals(shiftJisBody)).toBe(true);
      expect(response.body.includes(Buffer.from("data-uim-inspector"))).toBe(
        false
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("injects the inspector into application/xhtml+xml responses", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/xhtml+xml; charset=utf-8",
      });
      res.end("<html><body><main>xhtml</main></body></html>");
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      const body = response.body.toString("utf8");

      expect(body).toContain("xhtml");
      expect(body).toContain("data-uim-inspector");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("sniffs content-type-absent HTML and injects the inspector", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end("<!doctype html><html><body>sniffed</body></html>");
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      const body = response.body.toString("utf8");

      expect(response.headers["content-type"]).toBeUndefined();
      expect(body).toContain("sniffed");
      expect(body).toContain("data-uim-inspector");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("keeps injecting the inspector into UTF-8 text/html responses", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
      });
      res.end("<html><body>utf8</body></html>");
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      const body = response.body.toString("utf8");

      expect(body).toContain("utf8");
      expect(body).toContain("data-uim-inspector");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });
});
