import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./lib/env.ts";
import { api } from "./routes/api.ts";
import { stopProject } from "./lib/state.ts";
import { securityMiddleware } from "./middleware/security.ts";

const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.use("/api/*", securityMiddleware);
app.route("/api", api);

const bindHost = process.env.UIM_HOST ?? "127.0.0.1";
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

async function shutdown() {
  console.log("\n[UImaneger] shutting down...");
  await stopProject().catch(() => {});
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
