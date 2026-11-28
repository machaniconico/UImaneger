import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { api } from "./routes/api.ts";
import { createSecurityMiddleware, previewParentOrigins } from "./middleware/security.ts";
import { setPreviewParentOrigins } from "./lib/state.ts";
import { env, isProduction } from "./lib/env.ts";

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
  // `/API/...` や `//api/...` を SPA の 200 で返さないよう、先頭の重複スラッシュを畳み、
  // 大文字小文字を無視して API・assets の接頭辞を判定する。
  const normalized = path.replace(/^\/+/, "/").toLowerCase();
  if (normalized === "/api" || normalized.startsWith("/api/")) return false;
  if (normalized.startsWith("/assets/")) return false;
  const lastSegment = path.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return false;
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

export { isProduction };

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
  const securityPorts = resolveSecurityPorts(options);
  app.use("/api/*", createSecurityMiddleware(securityPorts));
  // プレビュープロキシの frame-ancestors と inspector も、この UI の origin に合わせる。
  setPreviewParentOrigins(previewParentOrigins(securityPorts));
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
