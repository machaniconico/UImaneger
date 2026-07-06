import http from "node:http";
import type { Duplex } from "node:stream";
import httpProxy from "http-proxy";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSPECTOR_PATH = join(__dirname, "..", "inspector-client.js");
const FRAME_ANCESTORS_CSP =
  "frame-ancestors 'self' http://localhost:* http://*.localhost:* http://127.0.0.1:* http://[::1]:*";
const HTML_SNIFF_BYTES = 1024;

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

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function htmlContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type === "text/html" || type === "application/xhtml+xml";
}

function charsetFromContentType(contentType: string): string | null {
  for (const part of contentType.split(";").slice(1)) {
    const [name, ...valueParts] = part.split("=");
    if (name?.trim().toLowerCase() !== "charset") continue;
    const value = valueParts.join("=").trim();
    if (!value) return null;
    return value.replace(/^["']|["']$/g, "").toLowerCase();
  }
  return null;
}

function injectableCharset(contentType: string): boolean {
  const charset = charsetFromContentType(contentType);
  return (
    !charset ||
    charset === "utf-8" ||
    charset === "utf8" ||
    charset === "us-ascii"
  );
}

function sniffHtmlBody(body: Buffer): boolean {
  const leading = body
    .subarray(0, HTML_SNIFF_BYTES)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  return leading.startsWith("<!doctype html") || leading.startsWith("<html");
}

function sniffHtmlStart(body: Buffer): "html" | "non-html" | "unknown" {
  const leading = body
    .subarray(0, HTML_SNIFF_BYTES)
    .toString("utf8")
    .replace(/^\uFEFF/, "")
    .trimStart()
    .toLowerCase();
  if (leading.startsWith("<!doctype html") || leading.startsWith("<html")) {
    return "html";
  }
  if (!leading) return body.byteLength >= HTML_SNIFF_BYTES ? "non-html" : "unknown";
  if ("<!doctype html".startsWith(leading) || "<html".startsWith(leading)) {
    return "unknown";
  }
  return "non-html";
}

function rewriteLocationValue(
  value: string | undefined,
  targetHost: string,
  proxyPort: number
): string | undefined {
  if (!value) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.host !== targetHost) return value;
  return `http://127.0.0.1:${proxyPort}${url.pathname}${url.search}${url.hash}`;
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
  const targetHost = `127.0.0.1:${targetPort}`;
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
    const declaredHtml = htmlContentType(ct);
    const mustSniff = ct.trim() === "";

    const headers = { ...proxyRes.headers };
    // フレーム埋め込みは localhost ファミリの UImaneger UI に限定する。
    delete headers["x-frame-options"];
    headers["content-security-policy"] = FRAME_ANCESTORS_CSP;
    // location は存在する時だけ書き換える。非リダイレクト応答(location 無し)で
    // undefined を代入すると res.writeHead が ERR_HTTP_INVALID_HEADER_VALUE を投げる。
    if (headers.location !== undefined) {
      headers.location = rewriteLocationValue(
        headers.location,
        targetHost,
        proxyPort
      );
    }

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

    const sendBufferedResponse = (rawBody: Buffer, isHtml: boolean) => {
      if (upstreamErrored || res.destroyed || res.writableEnded) return;
      if (!isHtml || !injectableCharset(ct)) {
        res.writeHead(proxyRes.statusCode || 200, headers);
        res.end(rawBody);
        return;
      }

      let body = rawBody.toString("utf8");
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
    };

    if (!declaredHtml && !mustSniff) {
      res.writeHead(proxyRes.statusCode || 200, headers);
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    if (mustSniff) {
      let bufferingForHtml = false;
      const streamBufferedThenPipe = () => {
        proxyRes.pause();
        proxyRes.off("data", onSniffData);
        proxyRes.off("end", onSniffEnd);
        res.writeHead(proxyRes.statusCode || 200, headers);
        for (const chunk of chunks) {
          res.write(chunk);
        }
        proxyRes.pipe(res);
        proxyRes.resume();
      };
      function onSniffData(c: Buffer) {
        chunks.push(Buffer.from(c));
        if (bufferingForHtml) return;
        const buffered = Buffer.concat(chunks);
        const decision = sniffHtmlStart(buffered);
        if (decision === "html") {
          bufferingForHtml = true;
          return;
        }
        if (decision === "non-html" || buffered.byteLength >= HTML_SNIFF_BYTES) {
          streamBufferedThenPipe();
        }
      }
      function onSniffEnd() {
        const rawBody = Buffer.concat(chunks);
        sendBufferedResponse(rawBody, sniffHtmlBody(rawBody));
      }
      proxyRes.on("data", onSniffData);
      proxyRes.on("end", onSniffEnd);
      return;
    }

    proxyRes.on("data", (c) => chunks.push(Buffer.from(c)));
    proxyRes.on("end", () => {
      sendBufferedResponse(Buffer.concat(chunks), declaredHtml);
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
