// @vitest-environment node
// R3 受け入れテスト: startProxy の Host / Origin 検証(HTTP・upgrade 共通)。
// 基準: .omc/plans/r3-csrf-acceptance.md(実装者は編集禁止)
import { describe, it, expect } from "vitest";
import http from "node:http";
import net from "node:net";
import { findFreePort } from "../../server/lib/runner.ts";
import { startProxy, type ProxyHandle } from "../../server/lib/proxy.ts";

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const a = server.address();
      if (a && typeof a === "object") resolve(a.port);
      else reject(new Error("no port"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function canBindLoopback(): Promise<boolean> {
  const s = http.createServer();
  try {
    await listen(s, "127.0.0.1");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  } finally {
    await closeServer(s);
  }
}

const hasLoopback = await canBindLoopback();
const describeIfLoopback = hasLoopback ? describe : describe.skip;

interface Fixture {
  P: number;
  counts: { requests: number; upgrades: number };
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Fixture> {
  const counts = { requests: 0, upgrades: 0 };
  const upstream = http.createServer((_req, res) => {
    counts.requests++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("upstream-ok");
  });
  upstream.on("upgrade", (_req, socket) => {
    counts.upgrades++;
    socket.write(
      ["HTTP/1.1 101 Switching Protocols", "Connection: Upgrade", "Upgrade: websocket", "", ""].join("\r\n")
    );
  });
  const upSockets = new Set<net.Socket>();
  upstream.on("connection", (sock) => {
    upSockets.add(sock);
    sock.once("close", () => upSockets.delete(sock));
  });
  const upPort = await listen(upstream, "127.0.0.1");
  const P = await findFreePort(31_000);
  let proxy: ProxyHandle | undefined;
  try {
    proxy = await startProxy(upPort, P);
  } catch (err) {
    await closeServer(upstream);
    throw err;
  }
  return {
    P,
    counts,
    cleanup: async () => {
      const closing = closeServer(upstream);
      for (const sock of upSockets) sock.destroy();
      await proxy?.close().catch(() => {});
      await closing;
    },
  };
}

function httpReq(
  P: number,
  headers: Record<string, string>,
  opts: { method?: string; path?: string } = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: P,
        method: opts.method ?? "GET",
        path: opts.path ?? "/",
        headers,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(opts.method === "POST" ? "{}" : undefined);
  });
}

/** WebSocket upgrade を生で送り、最初のステータス行を返す(応答なし切断は 0)。 */
function upgradeReq(P: number, headers: Record<string, string>): Promise<{ status: number; raw: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: P });
    let raw = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
      resolve({ status: m ? Number(m[1]) : 0, raw });
    };
    const timer = setTimeout(finish, 3000);
    socket.on("data", (c) => {
      raw += c.toString("utf8");
      if (raw.includes("\r\n")) finish();
    });
    socket.on("error", finish);
    socket.on("close", finish);
    socket.on("connect", () => {
      const lines = [
        "GET /ws HTTP/1.1",
        ...Object.entries({
          Connection: "Upgrade",
          Upgrade: "websocket",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
        }).map(([k, v]) => `${k}: ${v}`),
        "",
        "",
      ];
      socket.write(lines.join("\r\n"));
    });
  });
}

describeIfLoopback("proxy-host-origin", () => {
  it("http_allows_loopback_hosts", async () => {
    const f = await setup();
    try {
      for (const host of [`localhost:${f.P}`, `127.0.0.1:${f.P}`, `[::1]:${f.P}`]) {
        const r = await httpReq(f.P, { Host: host });
        expect(r.status, host).toBe(200);
        expect(r.body, host).toBe("upstream-ok");
      }
    } finally {
      await f.cleanup();
    }
  });

  it("http_rejects_rebinding_host", async () => {
    const f = await setup();
    try {
      for (const host of [`attacker.example:${f.P}`, "attacker.example", `foo.localhost:${f.P}`]) {
        const r = await httpReq(f.P, { Host: host });
        expect(r.status, host).toBe(403);
      }
      expect(f.counts.requests).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("http_rejects_foreign_origin", async () => {
    const f = await setup();
    try {
      for (const origin of ["http://evil.example", "http://localhost:5173", `http://localhost:${f.P + 1}`, "null"]) {
        const r = await httpReq(f.P, { Host: `localhost:${f.P}`, Origin: origin });
        expect(r.status, origin).toBe(403);
      }
      expect(f.counts.requests).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("http_allows_own_origin_post", async () => {
    const f = await setup();
    try {
      for (const name of ["localhost", "127.0.0.1"]) {
        const r = await httpReq(
          f.P,
          { Host: `${name}:${f.P}`, Origin: `http://${name}:${f.P}`, "Content-Type": "application/json" },
          { method: "POST" }
        );
        expect(r.status, name).toBe(200);
      }
      expect(f.counts.requests).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  it("http_allows_cross_site_iframe_navigation_without_origin", async () => {
    const f = await setup();
    try {
      const r = await httpReq(f.P, {
        Host: `localhost:${f.P}`,
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "iframe",
      });
      expect(r.status).toBe(200);
    } finally {
      await f.cleanup();
    }
  });

  it("inspector_route_is_host_checked", async () => {
    const f = await setup();
    try {
      const r = await httpReq(f.P, { Host: `attacker.example:${f.P}` }, { path: "/__uim/inspector.js" });
      expect(r.status).toBe(403);
    } finally {
      await f.cleanup();
    }
  });

  it("upgrade_rejects_rebinding_host", async () => {
    const f = await setup();
    try {
      const r = await upgradeReq(f.P, { Host: `attacker.example:${f.P}` });
      expect(r.status).not.toBe(101);
      expect(f.counts.upgrades).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("upgrade_rejects_foreign_origin", async () => {
    const f = await setup();
    try {
      for (const origin of ["http://evil.example", "http://localhost:5173", "null"]) {
        const r = await upgradeReq(f.P, { Host: `localhost:${f.P}`, Origin: origin });
        expect(r.status, origin).not.toBe(101);
      }
      expect(f.counts.upgrades).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("upgrade_allows_own_origin_and_no_origin", async () => {
    const f = await setup();
    try {
      const own = await upgradeReq(f.P, { Host: `localhost:${f.P}`, Origin: `http://localhost:${f.P}` });
      expect(own.status).toBe(101);
      expect(f.counts.upgrades).toBe(1);
      const none = await upgradeReq(f.P, { Host: `127.0.0.1:${f.P}` });
      expect(none.status).toBe(101);
    } finally {
      await f.cleanup();
    }
  });
});
