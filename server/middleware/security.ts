import type { MiddlewareHandler } from "hono";

const allowedHostnames = new Set(["localhost", "127.0.0.1", "::1"]);

function stripHostPort(host: string): string {
  const value = host.trim().toLowerCase();
  if (!value) return "";

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end === -1) return value;
    return value.slice(1, end);
  }

  const colonCount = (value.match(/:/g) ?? []).length;
  if (colonCount === 0) return value;
  if (colonCount === 1) return value.split(":")[0] ?? "";
  return value;
}

export function isAllowedHost(host: string): boolean {
  const hostname = stripHostPort(host);
  return allowedHostnames.has(hostname) || hostname.endsWith(".localhost");
}

export const securityMiddleware: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("origin");
  if (origin) {
    try {
      if (!isAllowedHost(new URL(origin).hostname)) {
        return c.json({ error: "forbidden" }, 403);
      }
    } catch {
      return c.json({ error: "forbidden" }, 403);
    }
  }

  const host = c.req.header("host");
  if (host && !isAllowedHost(host)) {
    return c.json({ error: "forbidden" }, 403);
  }

  await next();
};
