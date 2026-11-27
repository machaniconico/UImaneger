import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { api } from "./routes/api.ts";
import { createSecurityMiddleware } from "./middleware/security.ts";
import { env } from "./lib/env.ts";

export interface CreateAppOptions {
  production?: boolean;
  distRoot?: string;
  distExists?: boolean;
  useLogger?: boolean;
  /** API サーバのポート。既定 env.serverPort。 */
  serverPort?: number;
  /** dev 時の Vite ポート。既定 env.clientPort。production では無視(null 扱い)。 */
  clientPort?: number;
}

function shouldServeSpaFallback(path: string, method: string, accept: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/api" || path.startsWith("/api/")) return false;
  if (path.startsWith("/assets/")) return false;
  const lastSegment = path.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return false;
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

/**
 * 本番配信モードか。`--production` 引数は OS を問わず npm script から指定できるようにするため
 * (NODE_ENV=... の前置は Windows の cmd で使えない)。
 */
export function isProduction(
  options: CreateAppOptions,
  argv: readonly string[] = process.argv,
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  return options.production ?? (nodeEnv === "production" || argv.includes("--production"));
}

/** API の Origin 検査に使うポート。production では Vite(clientPort)を信頼しない。 */
export function resolveSecurityPorts(options: CreateAppOptions = {}): {
  serverPort: number;
  clientPort: number | null;
} {
  return {
    serverPort: options.serverPort ?? env.serverPort,
    clientPort: isProduction(options) ? null : options.clientPort ?? env.clientPort,
  };
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono();

  const production = isProduction(options);

  app.get("/health", (c) => c.text("ok"));
  if (options.useLogger ?? true) app.use("/api/*", logger());
  app.use("/api/*", createSecurityMiddleware(resolveSecurityPorts(options)));
  app.route("/api", api);

  const distRoot = options.distRoot ?? "./dist";
  const hasDist = options.distExists ?? existsSync(distRoot);
  if (production && hasDist) {
    const staticFiles = serveStatic({ root: distRoot });
    const indexFile = serveStatic({ root: distRoot, path: "index.html" });
    app.use("*", async (c, next) => {
      const path = c.req.path;
      if (path === "/api" || path.startsWith("/api/")) {
        return next();
      }
      return staticFiles(c, next);
    });
    app.all("*", async (c, next) => {
      if (
        shouldServeSpaFallback(
          c.req.path,
          c.req.method,
          c.req.header("accept") ?? ""
        )
      ) {
        return indexFile(c, next);
      }
      return next();
    });
  }

  return app;
}
