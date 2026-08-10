import http from "node:http";
import { Transform, type Duplex, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INSPECTOR_PATH = join(__dirname, "..", "inspector-client.js");
const INSPECTOR_ROUTE = "/__uim/inspector.js";
const FRAME_ANCESTORS_CSP =
  "frame-ancestors 'self' http://localhost:* http://*.localhost:* http://127.0.0.1:* http://[::1]:*";
const HTML_SNIFF_BYTES = 1024;

let inspectorScript: string | null | undefined;
function getInspectorScript(): string | null {
  if (inspectorScript === undefined) {
    try {
      inspectorScript = readFileSync(INSPECTOR_PATH, "utf8");
    } catch {
      inspectorScript = null;
    }
  }
  return inspectorScript || null;
}

function inspectorTag(): string {
  if (!getInspectorScript()) return "";
  return `\n<script data-uim-inspector src="${INSPECTOR_ROUTE}"></script>\n`;
}

class HtmlInjectionTransform extends Transform {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private injected = false;

  constructor(private readonly tag: string) {
    super();
  }

  private emitAvailable(final: boolean): void {
    if (this.injected) {
      if (this.pending) this.push(this.pending);
      this.pending = "";
      return;
    }

    const match = /<\/body\s*>/i.exec(this.pending);
    if (match?.index !== undefined) {
      const end = match.index + match[0].length;
      this.push(
        this.pending.slice(0, match.index) +
          this.tag +
          this.pending.slice(match.index, end)
      );
      this.pending = this.pending.slice(end);
      this.injected = true;
      if (this.pending) this.push(this.pending);
      this.pending = "";
      return;
    }

    if (final) {
      this.push(this.pending + this.tag);
      this.pending = "";
      this.injected = true;
      return;
    }

    // 閉じタグがチャンクを跨いでも検出できる分だけ末尾を保持する。
    const tailLength = 256;
    if (this.pending.length > tailLength) {
      this.push(this.pending.slice(0, -tailLength));
      this.pending = this.pending.slice(-tailLength);
    }
  }

  _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    try {
      this.pending += this.decoder.write(
        Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      );
      this.emitAvailable(false);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  _flush(callback: TransformCallback): void {
    try {
      this.pending += this.decoder.end();
      this.emitAvailable(true);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0].trim().toLowerCase();
}

function htmlContentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type === "text/html";
}

function frameableDocumentType(contentType: string): boolean {
  const type = mediaType(contentType);
  return type === "text/html" || type === "application/xhtml+xml";
}

function addSelfSource(directive: string): string {
  const parts = directive.trim().split(/\s+/);
  const name = parts.shift() || "script-src";
  const sources = parts.filter((part) => part.toLowerCase() !== "'none'");
  if (!sources.some((part) => part.toLowerCase() === "'self'")) {
    sources.push("'self'");
  }
  return [name, ...sources].join(" ");
}

function rewriteCspPolicy(policy: string): string {
  const directives = policy
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  let hasFrameAncestors = false;
  let hasScriptDirective = false;
  let hasDefaultSource = false;

  const rewritten = directives.map((directive) => {
    const name = directive.split(/\s+/, 1)[0].toLowerCase();
    if (name === "frame-ancestors") {
      hasFrameAncestors = true;
      return FRAME_ANCESTORS_CSP;
    }
    if (name === "script-src" || name === "script-src-elem") {
      hasScriptDirective = true;
      return addSelfSource(directive);
    }
    if (name === "default-src") hasDefaultSource = true;
    return directive;
  });

  if (!hasFrameAncestors) rewritten.push(FRAME_ANCESTORS_CSP);
  if (!hasScriptDirective && hasDefaultSource) rewritten.push("script-src 'self'");
  return rewritten.join("; ");
}

function rewriteCspHeader(
  value: http.OutgoingHttpHeader | undefined
): string | string[] {
  if (Array.isArray(value)) return value.map(rewriteCspPolicy);
  if (typeof value === "string") return rewriteCspPolicy(value);
  return FRAME_ANCESTORS_CSP;
}

function setOutgoingHeader(
  headers: http.OutgoingHttpHeaders,
  name: string,
  value: http.OutgoingHttpHeader
): void {
  (headers as Record<string, http.OutgoingHttpHeader | undefined>)[name] = value;
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
  if (url.protocol !== "http:" && url.protocol !== "https:") return value;
  let target: URL;
  try {
    target = new URL(`http://${targetHost}`);
  } catch {
    return value;
  }
  const normalizeHost = (hostname: string) =>
    hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopbackAliases = new Set(["localhost", "127.0.0.1", "::1"]);
  const sourceHost = normalizeHost(url.hostname);
  const expectedHost = normalizeHost(target.hostname);
  const sourcePort = Number(
    url.port || (url.protocol === "https:" ? "443" : "80")
  );
  const expectedPort = Number(target.port || "80");
  const sameHost =
    sourceHost === expectedHost ||
    (loopbackAliases.has(sourceHost) && loopbackAliases.has(expectedHost));
  if (!sameHost || sourcePort !== expectedPort) return value;
  return `http://localhost:${proxyPort}${url.pathname}${url.search}${url.hash}`;
}

function rewriteLocationHeader(
  value: http.OutgoingHttpHeader | undefined,
  targetHost: string,
  proxyPort: number
): string | undefined {
  if (typeof value === "string") {
    return rewriteLocationValue(value, targetHost, proxyPort);
  }
  if (Array.isArray(value)) {
    return rewriteLocationValue(value[0], targetHost, proxyPort);
  }
  if (typeof value === "number") return String(value);
  return undefined;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function withoutHopByHopHeaders(
  headers: http.IncomingHttpHeaders,
  opts?: { keepUpgrade?: boolean }
): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...headers };
  const connection = headers.connection;
  const connectionTokens = Array.isArray(connection)
    ? connection.join(",")
    : connection ?? "";
  for (const token of connectionTokens.split(",")) {
    const key = token.trim().toLowerCase();
    if (key) delete out[key];
  }
  for (const key of HOP_BY_HOP_HEADERS) {
    if (opts?.keepUpgrade && (key === "connection" || key === "upgrade")) {
      continue;
    }
    delete out[key];
  }
  return out;
}

function writeProxyError(
  res: http.ServerResponse,
  targetPort: number,
  err: Error
): void {
  console.error(
    `[UImaneger] proxy error (target :${targetPort}):`,
    err.message
  );
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("UImaneger proxy error: " + err.message);
  } else if (!res.writableEnded) {
    res.destroy(err);
  }
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
  proxyPort: number,
  targetHostname: "127.0.0.1" | "::1" = "127.0.0.1"
): Promise<ProxyHandle> {
  const targetHost = `${targetHostname === "::1" ? "[::1]" : targetHostname}:${targetPort}`;
  const sockets = new Set<Duplex>();

  function trackSocket<T extends Duplex>(socket: T): T {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }

  function handleUpstreamResponse(
    proxyRes: http.IncomingMessage,
    _req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    const ct = String(proxyRes.headers["content-type"] || "");
    const declaredHtml = htmlContentType(ct);
    const declaredDocument = frameableDocumentType(ct);
    const mustSniff = ct.trim() === "";
    const contentEncoding = String(
      proxyRes.headers["content-encoding"] || ""
    ).trim().toLowerCase();
    const encoded = Boolean(contentEncoding && contentEncoding !== "identity");

    const headers = withoutHopByHopHeaders(proxyRes.headers);
    const cspPolicies = proxyRes.headersDistinct?.["content-security-policy"];
    if (cspPolicies?.length) {
      setOutgoingHeader(headers, "content-security-policy", cspPolicies);
    }
    // location は存在する時だけ書き換える。非リダイレクト応答(location 無し)で
    // undefined を代入すると res.writeHead が ERR_HTTP_INVALID_HEADER_VALUE を投げる。
    if (headers.location !== undefined) {
      headers.location = rewriteLocationHeader(
        headers.location,
        targetHost,
        proxyPort
      );
    }

    const responseHeaders = (isHtml: boolean): http.OutgoingHttpHeaders => {
      const next: http.OutgoingHttpHeaders = { ...headers };
      if (!isHtml) return next;
      // HTML 文書だけフレーム許可を補正する。既存 CSP の他ディレクティブは維持する。
      delete next["x-frame-options"];
      setOutgoingHeader(
        next,
        "content-security-policy",
        rewriteCspHeader(next["content-security-policy"])
      );
      return next;
    };

    // ターゲット dev server が応答中にリセットしても unhandled "error" に
    // 昇格しないように、分岐前に error ハンドラを取り付ける(HTML / pipe 両パス共通)。
    let upstreamErrored = false;
    const onUpstreamError = (err: Error) => {
      if (upstreamErrored) return;
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
    };
    proxyRes.on("error", onUpstreamError);
    proxyRes.on("aborted", () =>
      onUpstreamError(new Error("upstream response aborted"))
    );
    res.on("error", (err) => {
      // クライアント側ソケットが去った場合の unhandled error 抑制
      console.error(
        `[UImaneger] proxy client response error (target :${targetPort}):`,
        err.message
      );
    });

    const sendBufferedResponse = (rawBody: Buffer, isHtml: boolean) => {
      if (upstreamErrored || res.destroyed || res.writableEnded) return;
      const outgoingHeaders = responseHeaders(isHtml);
      if (!isHtml || !injectableCharset(ct)) {
        res.writeHead(proxyRes.statusCode || 200, outgoingHeaders);
        res.end(rawBody);
        return;
      }

      let body = rawBody.toString("utf8");
      const tag = inspectorTag();
      if (tag) {
        if (/<\/body\s*>/i.test(body)) {
          body = body.replace(/<\/body\s*>/i, `${tag}$&`);
        } else {
          body += tag;
        }
      }
      delete outgoingHeaders["content-length"];
      delete outgoingHeaders["content-encoding"];
      delete outgoingHeaders["transfer-encoding"];
      outgoingHeaders["content-length"] = String(Buffer.byteLength(body));
      res.writeHead(proxyRes.statusCode || 200, outgoingHeaders);
      res.end(body);
    };

    const streamHtmlResponse = (initialChunks: Buffer[] = []) => {
      const outgoingHeaders = responseHeaders(true);
      const tag = inspectorTag();
      if (!tag || !injectableCharset(ct)) {
        res.writeHead(proxyRes.statusCode || 200, outgoingHeaders);
        for (const chunk of initialChunks) res.write(chunk);
        proxyRes.pipe(res);
        return;
      }

      delete outgoingHeaders["content-length"];
      delete outgoingHeaders["content-encoding"];
      delete outgoingHeaders["transfer-encoding"];
      res.writeHead(proxyRes.statusCode || 200, outgoingHeaders);
      const injector = new HtmlInjectionTransform(tag);
      injector.on("error", onUpstreamError);
      injector.pipe(res);
      for (const chunk of initialChunks) injector.write(chunk);
      proxyRes.pipe(injector);
    };

    const statusCode = proxyRes.statusCode || 200;
    const bodyless =
      _req.method === "HEAD" ||
      statusCode === 204 ||
      statusCode === 304 ||
      (statusCode >= 100 && statusCode < 200);
    if (bodyless || encoded) {
      res.writeHead(statusCode, responseHeaders(declaredDocument));
      proxyRes.pipe(res);
      return;
    }

    if (declaredHtml) {
      streamHtmlResponse();
      return;
    }

    if (!mustSniff) {
      res.writeHead(statusCode, responseHeaders(declaredDocument));
      proxyRes.pipe(res);
      return;
    }

    const chunks: Buffer[] = [];
    const streamBufferedThenPipe = () => {
      proxyRes.pause();
      proxyRes.off("data", onSniffData);
      proxyRes.off("end", onSniffEnd);
      res.writeHead(statusCode, responseHeaders(false));
      for (const chunk of chunks) {
        res.write(chunk);
      }
      proxyRes.pipe(res);
      proxyRes.resume();
    };
    const streamBufferedAsHtml = () => {
      proxyRes.pause();
      proxyRes.off("data", onSniffData);
      proxyRes.off("end", onSniffEnd);
      streamHtmlResponse(chunks);
      proxyRes.resume();
    };
    function onSniffData(c: Buffer) {
      chunks.push(Buffer.from(c));
      const buffered = Buffer.concat(chunks);
      const decision = sniffHtmlStart(buffered);
      if (decision === "html") {
        streamBufferedAsHtml();
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
  }

  const server = http.createServer((req, res) => {
    let requestPath = "/";
    try {
      requestPath = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      // 不正な URL は upstream に委ねる。
    }
    if (requestPath === INSPECTOR_ROUTE) {
      const script = getInspectorScript();
      if (!script) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Inspector script is unavailable");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, {
          allow: "GET, HEAD",
          "content-type": "text/plain; charset=utf-8",
        });
        res.end("Method Not Allowed");
        return;
      }
      const length = Buffer.byteLength(script);
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "content-length": String(length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(req.method === "HEAD" ? undefined : script);
      return;
    }

    const headers = withoutHopByHopHeaders(req.headers);
    headers.host = targetHost;
    // gzip を避けて本文を確実に書き換えられるように
    headers["accept-encoding"] = "identity";

    const proxyReq = http.request(
      {
        host: targetHostname,
        port: targetPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (proxyRes) => handleUpstreamResponse(proxyRes, req, res)
    );

    proxyReq.on("error", (err) => writeProxyError(res, targetPort, err));
    req.on("error", (err) => proxyReq.destroy(err));
    req.pipe(proxyReq);
  });
  server.on("connection", (socket) => {
    trackSocket(socket);
  });
  server.on("upgrade", (req, socket, head) => {
    trackSocket(socket);
    const headers = withoutHopByHopHeaders(req.headers, { keepUpgrade: true });
    headers.host = targetHost;
    headers.connection = req.headers.connection ?? "Upgrade";
    if (req.headers.upgrade) headers.upgrade = req.headers.upgrade;

    const proxyReq = http.request({
      host: targetHostname,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      trackSocket(proxySocket);
      socket.write(
        [
          `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
          ...Object.entries(proxyRes.headers).flatMap(([name, value]) => {
            if (value === undefined) return [];
            if (Array.isArray(value)) return value.map((v) => `${name}: ${v}`);
            return [`${name}: ${value}`];
          }),
          "",
          "",
        ].join("\r\n")
      );
      if (proxyHead.length) socket.write(proxyHead);
      if (head.length) proxySocket.write(head);
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
    });
    proxyReq.on("response", (proxyRes) => {
      socket.write(
        [
          `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
          ...Object.entries(proxyRes.headers).flatMap(([name, value]) => {
            if (value === undefined) return [];
            if (Array.isArray(value)) return value.map((v) => `${name}: ${v}`);
            return [`${name}: ${value}`];
          }),
          "",
          "",
        ].join("\r\n")
      );
      proxyRes.pipe(socket);
    });
    proxyReq.on("error", (err) => {
      console.error(
        `[UImaneger] proxy websocket error (target :${targetPort}):`,
        err.message
      );
      if (!socket.destroyed) {
        socket.end(
          "HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n"
        );
      }
    });
    proxyReq.end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(proxyPort, "127.0.0.1", () => {
      server.off("error", reject);
      let closePromise: Promise<void> | null = null;
      resolve({
        server,
        port: proxyPort,
        close: () => {
          closePromise ??= new Promise<void>((resolve) => {
            let settled = false;
            const done = () => {
              if (settled) return;
              settled = true;
              resolve();
            };
            const timer = setTimeout(done, 4_000);
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
          });
          return closePromise;
        },
      });
    });
  });
}
