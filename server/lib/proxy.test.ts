// ラウンド3: バックエンド ライフサイクル統合テスト (proxy)
// 対象: ProxyHandle.close の永久ハング修正の回帰
// 実 http サーバ・実ポートを使う node 環境テスト。
import { describe, it, expect, vi } from "vitest";
import http from "node:http";
import net from "node:net";
import { gzipSync } from "node:zlib";
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
  rawHeaders: string[];
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
            rawHeaders: res.rawHeaders,
            body: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

type AbortableProxyTestResponse = {
  statusCode: number;
  aborted: boolean;
  body: Buffer;
  errorMessage?: string;
};

function requestViaProxyAllowAbort(
  proxyPort: number,
  path = "/"
): Promise<AbortableProxyTestResponse> {
  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const finish = (
      statusCode: number,
      aborted: boolean,
      errorMessage?: string
    ) => {
      if (settled) return;
      settled = true;
      resolve({
        statusCode,
        aborted,
        body: Buffer.concat(chunks),
        errorMessage,
      });
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        path,
      },
      (res) => {
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => finish(res.statusCode || 0, false));
        res.on("aborted", () => finish(res.statusCode || 0, true));
        res.on("error", (err) =>
          finish(res.statusCode || 0, true, err.message)
        );
      }
    );
    req.on("error", (err) => finish(0, true, err.message));
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

describeIfLoopback("proxy upstream response errors", () => {
  it("returns 502 when the upstream response errors before proxy headers are sent", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = http.createServer((req) => {
      req.socket.destroy(new Error("synthetic upstream reset"));
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);
    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);

      const response = await requestViaProxy(proxyPort);

      expect(response.statusCode).toBe(502);
      expect(response.body.toString("utf8")).toContain(
        "UImaneger proxy error"
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
      consoleSpy.mockRestore();
    }
  });

  it("destroys the client response when the upstream response errors after proxy headers are sent", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
      res.write("partial body");
      setTimeout(() => {
        res.socket?.destroy(new Error("synthetic upstream reset"));
      }, 10);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);
    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);

      const response = await requestViaProxyAllowAbort(proxyPort);

      expect(response.statusCode).toBe(200);
      expect(response.aborted).toBe(true);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
      consoleSpy.mockRestore();
    }
  });
});

describeIfLoopback("proxy transport fidelity", () => {
  it("sets frame-ancestors to localhost-family origins only", async () => {
    const expectedCsp =
      "frame-ancestors 'self' http://localhost:* http://*.localhost:* http://127.0.0.1:* http://[::1]:*";
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "x-frame-options": "DENY",
        "content-security-policy":
          "default-src 'self'; img-src data:; frame-ancestors https://evil.com",
      });
      res.end("<html><body>framed</body></html>");
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);

      expect(response.headers["x-frame-options"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain(expectedCsp);
      expect(response.headers["content-security-policy"]).toContain(
        "default-src 'self'"
      );
      expect(response.headers["content-security-policy"]).toContain("img-src data:");
      expect(response.headers["content-security-policy"]).toContain(
        "script-src 'self'"
      );
      expect(response.headers["content-security-policy"]).not.toContain(
        "evil.com"
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("preserves multiple CSP policies as separate response headers", async () => {
    const upstream = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("content-security-policy", [
        "default-src 'self'",
        "img-src 'self'",
      ]);
      res.end("<html><body>policies</body></html>");
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      const policies: string[] = [];
      for (let i = 0; i < response.rawHeaders.length; i += 2) {
        if (response.rawHeaders[i]?.toLowerCase() === "content-security-policy") {
          policies.push(response.rawHeaders[i + 1] ?? "");
        }
      }

      expect(policies).toHaveLength(2);
      expect(policies.every((policy) => policy.includes("frame-ancestors"))).toBe(
        true
      );
      expect(policies[0]).toContain("default-src 'self'");
      expect(policies[0]).toContain("script-src 'self'");
      expect(policies[1]).toContain("img-src 'self'");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

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
        `http://localhost:${proxyPort}/next?from=target#frag`
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("rewrites localhost aliases that point at the target port", async () => {
    let upstreamPort = 0;
    const upstream = http.createServer((_req, res) => {
      res.writeHead(302, {
        "content-type": "text/plain",
        location: `http://localhost:${upstreamPort}/canonical`,
      });
      res.end("redirect");
    });
    upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      expect(response.headers.location).toBe(
        `http://localhost:${proxyPort}/canonical`
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
        `http://localhost:${proxyPort}/html-next`
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

  it("keeps XHTML byte-identical while allowing localhost iframe previews", async () => {
    const xhtml = Buffer.from(
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>xhtml</body></html>',
      "utf8"
    );
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/xhtml+xml; charset=utf-8",
        "content-length": String(xhtml.length),
        "x-frame-options": "DENY",
        "content-security-policy": "frame-ancestors https://example.com",
      });
      res.end(xhtml);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);
      expect(response.body.equals(xhtml)).toBe(true);
      expect(response.body.toString("utf8")).not.toContain("data-uim-inspector");
      expect(response.headers["x-frame-options"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain(
        "http://localhost:*"
      );
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("passes application/xhtml+xml through without invalid HTML script injection", async () => {
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
      expect(body).not.toContain("data-uim-inspector");
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("passes encoded HTML through byte-identical when upstream ignores identity", async () => {
    const encoded = gzipSync("<!doctype html><html><body>compressed</body></html>");
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-encoding": "gzip",
        "content-length": String(encoded.byteLength),
      });
      res.end(encoded);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort);

      expect(response.headers["content-encoding"]).toBe("gzip");
      expect(response.body.equals(encoded)).toBe(true);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("serves the inspector from the proxy origin without contacting upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamRequests++;
      res.writeHead(404);
      res.end();
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const response = await requestViaProxy(proxyPort, "/__uim/inspector.js");

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("application/javascript");
      expect(response.body.toString("utf8")).toContain("__uimInspectorLoaded");
      expect(upstreamRequests).toBe(0);
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

  it("streams content-type-absent non-HTML responses without buffering the full body", async () => {
    const firstChunk = Buffer.from('{"kind":"asset"}\n');
    const tail = Buffer.alloc(1024 * 1024, "a");
    let released = false;
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => {
      releaseRest = () => {
        released = true;
        resolve();
      };
    });
    const upstream = http.createServer(async (_req, res) => {
      res.writeHead(200, {
        "content-length": String(firstChunk.byteLength + tail.byteLength),
      });
      res.flushHeaders();
      res.write(firstChunk);
      await restGate;
      res.end(tail);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const chunks: Buffer[] = [];
      let sawFirstChunk = false;
      let resolveFirstChunk!: (chunk: Buffer) => void;
      let rejectFirstChunk!: (err: Error) => void;
      const firstChunkSeen = new Promise<Buffer>((resolve, reject) => {
        resolveFirstChunk = resolve;
        rejectFirstChunk = reject;
      });
      const done = new Promise<Buffer>((resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: "/asset",
          },
          (res) => {
            res.on("data", (chunk) => {
              const b = Buffer.from(chunk);
              chunks.push(b);
              if (!sawFirstChunk) {
                sawFirstChunk = true;
                resolveFirstChunk(b);
              }
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          }
        );
        req.on("error", reject);
        req.end();
      });
      const timer = setTimeout(() => {
        rejectFirstChunk(
          new Error("timed out waiting for streamed non-HTML chunk")
        );
      }, 1_000);

      let streamedChunk: Buffer;
      try {
        streamedChunk = await firstChunkSeen;
      } catch (err) {
        releaseRest();
        throw err;
      } finally {
        clearTimeout(timer);
      }

      expect(streamedChunk.toString("utf8")).toContain('{"kind":"asset"}');
      expect(released).toBe(false);
      releaseRest();
      const body = await done;
      expect(body.byteLength).toBe(firstChunk.byteLength + tail.byteLength);
      expect(body.subarray(0, firstChunk.byteLength).equals(firstChunk)).toBe(
        true
      );
    } finally {
      if (!released) releaseRest();
      if (handle) await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    }
  });

  it("streams declared UTF-8 HTML while still injecting the inspector", async () => {
    const firstChunk = Buffer.from(
      "<!doctype html><html><body>" + "a".repeat(2048)
    );
    const tail = Buffer.from("</body></html>");
    let released = false;
    let releaseRest!: () => void;
    const restGate = new Promise<void>((resolve) => {
      releaseRest = () => {
        released = true;
        resolve();
      };
    });
    const upstream = http.createServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.flushHeaders();
      res.write(firstChunk);
      await restGate;
      res.end(tail);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);

    let handle: ProxyHandle | null = null;
    try {
      handle = await startProxy(upstreamPort, proxyPort);
      const chunks: Buffer[] = [];
      let resolveFirstChunk!: (chunk: Buffer) => void;
      const firstChunkSeen = new Promise<Buffer>((resolve) => {
        resolveFirstChunk = resolve;
      });
      const done = new Promise<Buffer>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: proxyPort, path: "/ssr" },
          (res) => {
            let first = true;
            res.on("data", (chunk) => {
              const value = Buffer.from(chunk);
              chunks.push(value);
              if (first) {
                first = false;
                resolveFirstChunk(value);
              }
            });
            res.on("end", () => resolve(Buffer.concat(chunks)));
            res.on("error", reject);
          }
        );
        req.on("error", reject);
        req.end();
      });

      const streamed = await Promise.race([
        firstChunkSeen,
        sleep(1_000).then(() => {
          throw new Error("timed out waiting for streamed HTML chunk");
        }),
      ]);
      expect(streamed.toString("utf8")).toContain("<!doctype html>");
      expect(released).toBe(false);

      releaseRest();
      const body = (await done).toString("utf8");
      expect(body).toContain("data-uim-inspector");
      expect(body).toContain("</body></html>");
    } finally {
      if (!released) releaseRest();
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

// ブラウザがプレビューを閉じた瞬間の WebSocket 切断でサーバが落ちない回帰 (EPIPE/ECONNRESET)。
describeIfLoopback("proxy websocket client disconnects", () => {
  async function setup(delayUpgradeMs: number) {
    const upstreamSockets = new Set<net.Socket>();
    // http.Server のソケットは allowHalfOpen なので、destroyed ではなく end/close で切断を判定する。
    const disconnected = new WeakSet<net.Socket>();
    const upstream = http.createServer();
    upstream.on("upgrade", (_req, duplex) => {
      const socket = duplex as net.Socket;
      upstreamSockets.add(socket);
      socket.on("error", () => {});
      socket.once("end", () => disconnected.add(socket));
      socket.once("close", () => disconnected.add(socket));
      setTimeout(() => {
        if (socket.destroyed) return;
        socket.write(
          ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket", "", ""].join("\r\n")
        );
      }, delayUpgradeMs);
    });
    const upstreamPort = await listenOnFreePort(upstream, "127.0.0.1");
    const proxyPort = await findFreePort(upstreamPort + 1);
    const handle = await startProxy(upstreamPort, proxyPort);
    const allUpstreamClosed = () =>
      waitUntilFalse(async () => [...upstreamSockets].some((s) => !disconnected.has(s)), 3_000);
    const cleanup = async () => {
      for (const s of upstreamSockets) s.destroy();
      await handle.close().catch(() => {});
      await closeServer(upstream).catch(() => {});
    };
    return { proxyPort, upstreamSockets, allUpstreamClosed, cleanup };
  }

  it("closes the upstream socket when the client leaves before the upgrade completes", async () => {
    const ctx = await setup(300);
    try {
      const client = net.connect({ host: "127.0.0.1", port: ctx.proxyPort });
      client.on("error", () => {});
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write(
        [
          "GET /hmr HTTP/1.1",
          `Host: 127.0.0.1:${ctx.proxyPort}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "",
          "",
        ].join("\r\n")
      );
      await waitUntilFalse(async () => ctx.upstreamSockets.size === 0, 2_000);
      client.destroy();
      await sleep(500);
      expect(await ctx.allUpstreamClosed()).toBe(true);
      // プロキシは生きていて次の upgrade を受け付ける
      const next = await upgradeViaProxy(ctx.proxyPort).catch(() => null);
      // 上流は 300ms 遅延するので upgradeViaProxy の 2s 以内に 101 が返る
      expect(next).not.toBeNull();
      next?.destroy();
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);

  it("survives a client RST after the upgrade and closes the upstream socket", async () => {
    const ctx = await setup(0);
    try {
      const client = await upgradeViaProxy(ctx.proxyPort);
      client.on("error", () => {});
      client.resetAndDestroy();
      expect(await ctx.allUpstreamClosed()).toBe(true);
      expect(await isListening(ctx.proxyPort)).toBe(true);
      const next = await upgradeViaProxy(ctx.proxyPort);
      next.destroy();
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);
});
