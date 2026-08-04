import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { api } from "./routes/api.ts";
import { securityMiddleware } from "./middleware/security.ts";

export interface CreateAppOptions {
  production?: boolean;
  distRoot?: string;
  distExists?: boolean;
  useLogger?: boolean;
}

function shouldServeSpaFallback(path: string, method: string, accept: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (path === "/api" || path.startsWith("/api/")) return false;
  if (path.startsWith("/assets/")) return false;
  const lastSegment = path.split("/").pop() ?? "";
  if (lastSegment.includes(".")) return false;
  return !accept || accept.includes("text/html") || accept.includes("*/*");
}

export function createApp(options: CreateAppOptions = {}): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.text("ok"));
  if (options.useLogger ?? true) app.use("/api/*", logger());
  app.use("/api/*", securityMiddleware);
  app.route("/api", api);

  const distRoot = options.distRoot ?? "./dist";
  const production = options.production ?? process.env.NODE_ENV === "production";
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
