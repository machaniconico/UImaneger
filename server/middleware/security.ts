import type { MiddlewareHandler } from "hono";

// loopback のホスト名だけを許可する。*.localhost は DNS rebinding 対策で外す。
export const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"] as const;
const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

// Host = "[::1]" / "[::1]:port" / "name" / "name:port"(port は数字のみ)。それ以外の形式は null。
// 括弧なしの "::1" は従来どおり受け付ける。
function parseHostname(host: string): string | null {
  const value = host.trim().toLowerCase();
  if (value === "::1") return value;
  const m = /^(?:\[(::1)\]|([^:\[\]]+))(?::(\d{1,5}))?$/.exec(value);
  if (!m) return null;
  return m[1] ?? m[2] ?? null;
}

/** Host ヘッダのホスト名が loopback 3 種か(ポートは問わない)。 */
export function isAllowedHost(host: string): boolean {
  const hostname = parseHostname(host);
  return hostname !== null && allowedHostnames.has(hostname);
}

/** 指定ポート群で許可する Origin(`http://{loopback}:{port}`)の一覧。 */
export function loopbackOrigins(ports: readonly number[]): string[] {
  // 既定ポート 80 ではブラウザが Origin のポートを省略する。
  return ports.flatMap((port) =>
    LOOPBACK_HOSTNAMES.flatMap((hostname) =>
      port === 80
        ? [`http://${hostname}:${port}`, `http://${hostname}`]
        : [`http://${hostname}:${port}`]
    )
  );
}

/** API で許可する Origin。dev のみ Vite(clientPort)の origin も含む。 */
export function allowedApiOrigins(options: {
  serverPort: number;
  clientPort: number | null;
}): string[] {
  const ports = [options.serverPort];
  if (options.clientPort !== null && options.clientPort !== options.serverPort) {
    ports.push(options.clientPort);
  }
  return loopbackOrigins(ports);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_FETCH_SITES = new Set(["same-origin", "none"]);

function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  // HTTP の OWS は SP と HTAB のみ。String#trim は NBSP 等の Unicode 空白まで除去してしまう。
  const mediaType = value.split(";")[0]?.replace(/^[ \t]+|[ \t]+$/g, "").toLowerCase();
  if (mediaType !== "application/json") return false;

  // ブラウザの fetch は Content-Type の重複値を 1 行に結合するため、Vite が重複行の先頭値だけを転送する挙動は許容する。
  let quoted = false;
  for (let i = value.indexOf(";") + 1; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === "\\") {
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      return false;
    }
  }
  return !quoted;
}

/**
 * /api/* 用の CSRF / DNS rebinding 対策。
 * - Origin があれば UI の origin と完全一致のみ許可(null・別ポート・https は 403)
 * - Host は loopback 名のみ(ポート不問)
 * - Sec-Fetch-Site は無し / same-origin / none のみ
 * - 状態変更メソッドは Content-Type: application/json 必須(単純リクエストを封じる)
 * CORS 応答ヘッダは一切出さない。
 */
export function createSecurityMiddleware(options: {
  serverPort: number;
  clientPort: number | null;
}): MiddlewareHandler {
  const origins = new Set(allowedApiOrigins(options));

  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !origins.has(origin)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const host = c.req.header("host");
    if (host !== undefined && !isAllowedHost(host)) {
      return c.json({ error: "forbidden" }, 403);
    }

    const fetchSite = c.req.header("sec-fetch-site");
    if (fetchSite !== undefined && !ALLOWED_FETCH_SITES.has(fetchSite.trim().toLowerCase())) {
      return c.json({ error: "forbidden" }, 403);
    }

    if (
      !SAFE_METHODS.has(c.req.method.toUpperCase()) &&
      !isJsonContentType(c.req.header("content-type"))
    ) {
      return c.json({ error: "unsupported media type" }, 415);
    }

    await next();
  };
}
