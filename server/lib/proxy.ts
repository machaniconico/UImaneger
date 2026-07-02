import http from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSPECTOR_PATH = join(__dirname, "..", "inspector-client.js");

let inspectorScript: string | null | undefined;
function inspectorTag(): string {
  if (inspectorScript === undefined) {
    try {
      inspectorScript = readFileSync(INSPECTOR_PATH, "utf8");
    } catch {
      inspectorScript = null;
    }
  }
  if (!inspectorScript) return "";
  return `\n<script data-uim-inspector>${inspectorScript}</script>\n`;
}

export interface ProxyHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

/**
 * targetPort の dev server を中継し、HTML に inspector を注入するプロキシを proxyPort で起動。
 * WebSocket(HMR) は透過。
 */
export function startProxy(
  targetPort: number,
  proxyPort: number
): Promise<ProxyHandle> {
  const target = `http://127.0.0.1:${targetPort}`;
  const proxy = httpProxy.createProxyServer({
    target,
    ws: true,
    selfHandleResponse: true, // HTML を書き換えるため自前で返す
    changeOrigin: true,
  });

  // gzip を避けて本文を確実に書き換えられるように
  proxy.on("proxyReq", (proxyReq) => {
    proxyReq.setHeader("accept-encoding", "identity");
  });

  proxy.on("proxyRes", (proxyRes, req, res) => {
    const ct = String(proxyRes.headers["content-type"] || "");
    const isHtml = ct.includes("text/html");

    const headers = { ...proxyRes.headers };
    // フレーム埋め込みを許可
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];

    // ターゲット dev server が応答中にリセットしても unhandled "error" に
    // 昇格しないように、分岐前に error ハンドラを取り付ける(HTML / pipe 両パス共通)。
    let upstreamErrored = false;
    proxyRes.on("error", (err) => {
      upstreamErrored = true;
      console.error(
        `[UImaneger] proxy upstream error (target :${targetPort}):`,
        err.message
      );
      if (!res.headersSent) {
        try {
          res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
          res.end("UImaneger proxy upstream error: " + err.message);
        } catch {
          try {
            res.end();
          } catch {
            // 既に閉じているなら無視
          }
        }
      } else if (!res.writableEnded) {
        res.destroy(err);
      }
    });
    res.on("error", (err) => {
      // クライアント側ソケットが去った場合の unhandled error 抑制
      console.error(
        `[UImaneger] proxy client response error (target :${targetPort}):`,
        err.message
      );
    });

    if (!isHtml) {
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (c) => chunks.push(Buffer.from(c)));
    proxyRes.on("end", () => {
      if (upstreamErrored || res.destroyed || res.writableEnded) return;
      let body = Buffer.concat(chunks).toString("utf8");
      const tag = inspectorTag();
      if (tag) {
        if (body.includes("</body>")) {
          body = body.replace("</body>", tag + "</body>");
        } else {
          body += tag;
        }
      }
      delete headers["content-length"];
      delete headers["content-encoding"];
      delete headers["transfer-encoding"];
      headers["content-length"] = String(Buffer.byteLength(body));
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(body);
    });
  });

  proxy.on("error", (err, _req, res) => {
    // 死んだターゲット等の proxy error を端末にトレース出力(S15)
    console.error(
      `[UImaneger] proxy error (target :${targetPort}):`,
      err.message
    );
    if (res && "writeHead" in res && !res.headersSent) {
      (res as http.ServerResponse).writeHead(502, {
        "content-type": "text/plain; charset=utf-8",
      });
      (res as http.ServerResponse).end("UImaneger proxy error: " + err.message);
    }
  });

  const server = http.createServer((req, res) => {
    proxy.web(req, res);
  });
  const sockets = new Set<Duplex>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (req, socket, head) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    proxy.ws(req, socket, head);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, "127.0.0.1", () => {
      resolve({
        server,
        port: proxyPort,
        close: () =>
          new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const timer = setTimeout(done, 4_000);
            proxy.close();
            server.close(() => {
              clearTimeout(timer);
              done();
            });
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            for (const s of sockets) {
              if (!s.destroyed) s.destroy();
            }
          }),
      });
    });
  });
}
