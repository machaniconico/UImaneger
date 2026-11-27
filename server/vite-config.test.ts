// @vitest-environment node
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import viteConfig, { resolveDevPorts } from "../vite.config.ts";
import { createApp } from "./app.ts";

function getStatus(port: number, host: string) {
  return new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = http.get({
      host: "127.0.0.1",
      port,
      path: "/api/status",
      headers: { host },
      signal: AbortSignal.timeout(3_000),
    }, async (res) => {
      try {
        res.setEncoding("utf8");
        let body = "";
        for await (const chunk of res) body += chunk;
        resolve({ status: res.statusCode, body });
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

describe("vite.config.ts", () => {
  it("disables Vite's default dev CORS (no Access-Control-Allow-Origin for other localhost ports)", () => {
    expect((viteConfig as { server?: { cors?: unknown } }).server?.cors).toBe(false);
  });

  it("reads UIM_SERVER_PORT / UIM_CLIENT_PORT from .env with process.env taking precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "uim-vite-env-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "UIM_CLIENT_PORT=5200\nUIM_SERVER_PORT=5300\n");
      expect(resolveDevPorts({}, envFile)).toEqual({ serverPort: 5300, clientPort: 5200 });
      expect(resolveDevPorts({ UIM_CLIENT_PORT: "5400" }, envFile)).toEqual({
        serverPort: 5300,
        clientPort: 5400,
      });
      expect(resolveDevPorts({}, join(dir, "missing.env"))).toEqual({
        serverPort: 5174,
        clientPort: 5173,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(["win32", "linux"] as const)("reads ports from a CRLF .env on %s", (platform) => {
    const dir = mkdtempSync(join(tmpdir(), "uim-vite-env-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "UIM_CLIENT_PORT=5250\r\nUIM_SERVER_PORT=5350\r\n");
      expect(resolveDevPorts({}, envFile, platform)).toEqual({ serverPort: 5350, clientPort: 5250 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves .env port keys with the API server's platform-specific casing and precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "uim-vite-env-"));
    try {
      const envFile = join(dir, ".env");
      writeFileSync(envFile, "uim_client_port=5250\nUIM_CLIENT_PORT=5260\nUim_Server_Port=5350\n");
      expect(resolveDevPorts({}, envFile, "win32")).toEqual({ serverPort: 5350, clientPort: 5250 });
      expect(resolveDevPorts({ uim_client_port: "5400" }, envFile, "win32")).toEqual({
        serverPort: 5350,
        clientPort: 5400,
      });
      expect(resolveDevPorts({}, envFile, "linux")).toEqual({ serverPort: 5174, clientPort: 5260 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets the API reject foo.localhost through the running Vite proxy", async () => {
    const app = createApp({ production: false, useLogger: false });
    const api = http.createServer(getRequestListener(app.fetch));
    try {
      api.listen(0, "localhost");
      await once(api, "listening");
      const address = api.address();
      if (!address || typeof address === "string") throw new Error("API did not bind a TCP port");

      const vite = spawn(process.execPath, ["--input-type=module", "-e", `
        import { createServer } from "vite";
        const vite = await createServer({
          server: { host: "127.0.0.1", port: 0, watch: null, ws: false },
        });
        await vite.listen();
        process.send(vite.httpServer.address().port);
      `], {
        env: { ...process.env, UIM_SERVER_PORT: String(address.port), UIM_CLIENT_PORT: "5173" },
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const closed = new Promise<void>((resolve) => vite.once("close", () => resolve()));
      try {
        const [port] = await Promise.race([
          once(vite, "message", { signal: AbortSignal.timeout(8_000) }),
          closed.then(() => { throw new Error("Vite exited before reporting its port"); }),
        ]);
        expect((await getStatus(port, `localhost:${port}`)).status).toBe(200);
        const rejected = await getStatus(port, "foo.localhost");
        expect(rejected.status).toBe(403);
        expect(JSON.parse(rejected.body)).toEqual({ error: "forbidden" });
      } finally {
        vite.kill();
        await closed;
      }
    } finally {
      await new Promise<void>((resolve) => api.close(() => resolve()));
    }
  }, 16_000);
});
