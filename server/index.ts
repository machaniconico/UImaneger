import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { existsSync } from "node:fs";
import { env } from "./lib/env.ts";
import { api } from "./routes/api.ts";
import { stopProject } from "./lib/state.ts";
import { killAllChildrenSync } from "./lib/runner.ts";
import { cleanupAllBefore, sweepStaleBeforeDirs } from "./lib/worktree.ts";
import { securityMiddleware } from "./middleware/security.ts";

const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.use("/api/*", logger());
app.use("/api/*", securityMiddleware);
app.route("/api", api);

if (process.env.NODE_ENV === "production" && existsSync("dist")) {
  const staticFiles = serveStatic({ root: "./dist" });
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path === "/api" || path.startsWith("/api/")) {
      return next();
    }
    return staticFiles(c, next);
  });
}

sweepStaleBeforeDirs();

const rawHost = process.env.UIM_HOST?.trim();
const bindHost = rawHost ? rawHost : "127.0.0.1";
const server = serve(
  { fetch: app.fetch, hostname: bindHost, port: env.serverPort },
  (info) => {
    console.log(`[UImaneger] server listening on http://${bindHost}:${info.port}`);
    if (!env.anthropicKey) {
      console.log(
        "[UImaneger] 注意: ANTHROPIC_API_KEY 未設定。編集機能には .env が必要です。"
      );
    }
  }
);

// S5: ポート使用中(EADDRINUSE)は生スタックでなく一行の対処メッセージで終了。
// vite.config.ts は触らない(別プロセス)。サーバ起動時点で弾けば十分。
server.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EADDRINUSE") {
    console.error(
      `[UImaneger] ポート ${env.serverPort} は使用中です。別のプロセスが起動していないか確認し、必要なら UIM_SERVER_PORT を変更してください。`
    );
    process.exit(1);
  }
  throw e;
});

// --- S4: クラッシュ安全シャットダウン ---
// 再入可能な gracefulExit。SIGINT/SIGTERM は code=0、uncaught/unhandled は code=1。
let shuttingDown = false;

function safeErrorLog(label: string, value?: unknown): void {
  try {
    if (value === undefined) console.error(label);
    else console.error(label, value);
  } catch {
    // ログ出力自体の失敗で crash handler を再帰させない。
  }
}

async function gracefulExit(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // ハードキル: どれだけ後始末が詰まっても 6s 後には確実に落とす(unref で保持しない)
  const hardKill = setTimeout(() => {
    try {
      killAllChildrenSync();
    } catch (err) {
      safeErrorLog(
        "[UImaneger] child cleanup during hard shutdown failed:",
        err
      );
    }
    try {
      cleanupAllBefore();
    } catch (err) {
      safeErrorLog(
        "[UImaneger] before cleanup during hard shutdown failed:",
        err
      );
    }
    process.exit(code);
  }, 6_000);
  hardKill.unref();
  try {
    console.log("\n[UImaneger] shutting down...");
    await stopProject().catch((err) => {
      safeErrorLog("[UImaneger] stopProject during shutdown failed:", err);
    });
    try {
      server.close();
    } catch (err) {
      safeErrorLog("[UImaneger] server close during shutdown failed:", err);
    }
  } catch (err) {
    safeErrorLog("[UImaneger] shutdown failed:", err);
  } finally {
    clearTimeout(hardKill);
    try {
      killAllChildrenSync();
    } catch (err) {
      safeErrorLog("[UImaneger] child cleanup during shutdown failed:", err);
    }
    try {
      cleanupAllBefore();
    } catch (err) {
      safeErrorLog("[UImaneger] before cleanup during shutdown failed:", err);
    }
    process.exit(code);
  }
}

process.on("SIGINT", () => {
  void gracefulExit(0);
});
process.on("SIGTERM", () => {
  void gracefulExit(0);
});
process.on("SIGHUP", () => {
  void gracefulExit(0);
});
process.on("uncaughtException", (err) => {
  // クラッシュを隠さず非ゼロで抜ける
  safeErrorLog("[UImaneger] uncaughtException:", err);
  void gracefulExit(1);
});
process.on("unhandledRejection", (reason) => {
  safeErrorLog("[UImaneger] unhandledRejection:", reason);
  void gracefulExit(1);
});
