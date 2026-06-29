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

    if (!isHtml) {
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    proxyRes.on("data", (c) => chunks.push(Buffer.from(c)));
    proxyRes.on("end", () => {
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
      headers["content-length"] = String(Buffer.byteLength(body));
      res.writeHead(proxyRes.statusCode || 200, headers);
      res.end(body);
    });
  });

  proxy.on("error", (err, _req, res) => {
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
