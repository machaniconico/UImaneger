import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { env } from "./lib/env.ts";
import { api } from "./routes/api.ts";
import { stopProject } from "./lib/state.ts";

const app = new Hono();

app.get("/health", (c) => c.text("ok"));
app.route("/api", api);

const server = serve(
  { fetch: app.fetch, port: env.serverPort },
  (info) => {
    console.log(`[UImaneger] server listening on http://localhost:${info.port}`);
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
