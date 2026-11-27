import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const host = "127.0.0.1";
export const model = "claude-e2e";
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- 偽 Anthropic サーバ専用のダミー値
export const apiKey = "e2e-fake-key";
export const originalHeading = "サンプルアプリ";
export const editedHeading = "ブラウザE2Eで編集済み";
export const relFile = "src/App.tsx";

interface MessagesRequest {
  method: string | undefined;
  path: string | undefined;
  apiKey: string | string[] | undefined;
  body: {
    model?: string;
    max_tokens?: number;
    stream?: boolean;
    messages?: { role: string; content: string }[];
  };
}

interface AppFixture {
  url: string;
  sample: string;
  file: string;
  original: string;
  edited: string;
  requests: MessagesRequest[];
}

async function listen(server: Server) {
  const listening = once(server, "listening");
  server.listen(0, host);
  await listening;
  return (server.address() as AddressInfo).port;
}

async function close(server: Server) {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

async function getAppPorts() {
  const sockets = [createServer(), createServer()];
  try {
    const [clientPort, serverPort] = await Promise.all(sockets.map(listen));
    return { clientPort, serverPort };
  } finally {
    await Promise.all(sockets.filter((socket) => socket.listening).map(close));
  }
}

function startProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  function appendLog(chunk: Buffer | Error) {
    logs += chunk.toString();
  }
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);
  child.on("error", appendLog);
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  return {
    logs: () => logs,
    async stop() {
      if (process.platform === "win32" && child.pid && child.exitCode === null) {
        // Windows の kill() は直下の 1 プロセスしか止めない。tsx の実サーバや、そこから起動した
        // dev server が残って一時ディレクトリを掴み続けるため、製品と同じくツリーごと止める。
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      }
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child.kill("SIGKILL"), 8_000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function stageSample(sample: string) {
  await cp(join(repo, "examples/sample-app"), sample, {
    recursive: true,
    filter: (path) => !["node_modules", "dist", ".git"].includes(basename(path)),
  });

  // Reuse the packages installed by the root lockfile.
  const modules = join(sample, "node_modules");
  await mkdir(join(modules, ".bin"), { recursive: true });
  await mkdir(join(modules, "@vitejs"));
  for (const entry of ["react", "react-dom", "vite", "@vitejs/plugin-react", ".bin/vite"]) {
    await symlink(join(repo, "node_modules", entry), join(modules, entry));
  }

  // The before snapshot shares node_modules with the live app. Keep the two
  // Vite optimizers from overwriting each other's dependency cache.
  const configFile = join(sample, "vite.config.ts");
  const config = await readFile(configFile, "utf8");
  const isolatedConfig = config.replace('defineConfig({', 'defineConfig({\n  cacheDir: ".vite",');
  expect(isolatedConfig).not.toBe(config);
  await writeFile(configFile, isolatedConfig);
}

export const test = base.extend<{ app: AppFixture }>({
  app: async ({}, use, testInfo) => {
    const temp = await mkdtemp(join(tmpdir(), "uim-e2e-"));
    let anthropic: Server | undefined;
    const processes: Record<string, ReturnType<typeof startProcess>> = {};
    try {
      const sample = join(temp, "sample-app");
      await stageSample(sample);
      const file = join(sample, relFile);
      const original = await readFile(file, "utf8");
      expect(original).toContain(originalHeading);
      const edited = original.replace(originalHeading, editedHeading);
      const requests: MessagesRequest[] = [];
      anthropic = createServer(async (req, res) => {
        try {
          req.setEncoding("utf8");
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const body: MessagesRequest["body"] = JSON.parse(raw);
          requests.push({
            method: req.method,
            path: req.url,
            apiKey: req.headers["x-api-key"],
            body,
          });
          if (req.method !== "POST" || req.url !== "/v1/messages") {
            res.writeHead(404).end();
            return;
          }
          const text = ["```tsx", edited, "```"].join("\n");
          if (body.stream) {
            // 編集生成は SDK の messages.stream() を使うため、Messages API の SSE 形式で返す
            res.setHeader("Content-Type", "text/event-stream");
            const events: [string, unknown][] = [
              ["message_start", {
                type: "message_start",
                message: {
                  id: "msg_e2e",
                  type: "message",
                  role: "assistant",
                  model,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              }],
              ["content_block_start", {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              }],
              ["content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text },
              }],
              ["content_block_stop", { type: "content_block_stop", index: 0 }],
              ["message_delta", {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              }],
              ["message_stop", { type: "message_stop" }],
            ];
            for (const [event, data] of events) {
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            }
            res.end();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            id: "msg_e2e",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }));
        } catch {
          res.writeHead(400).end();
        }
      });
      const anthropicPort = await listen(anthropic);
      const { clientPort, serverPort } = await getAppPorts();

      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !/^ANTHROPIC_/i.test(key)),
      );
      Object.assign(env, {
        NODE_ENV: "development",
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: `http://${host}:${anthropicPort}`,
        UIM_EDIT_MODEL: model,
        UIM_HOST: host,
        UIM_SERVER_PORT: String(serverPort),
        UIM_CLIENT_PORT: String(clientPort),
        UIM_WORKSPACES_DIR: join(temp, "workspaces"),
        TMPDIR: temp,
      });

      processes.hono = startProcess(
        ["--import", import.meta.resolve("tsx"), join(repo, "server/index.ts")],
        temp,
        env,
      );
      processes.vite = startProcess(
        [join(repo, "node_modules/vite/bin/vite.js"), "--host", host, "--strictPort"],
        repo,
        env,
      );
      const url = `http://${host}:${clientPort}`;
      await expect.poll(async () => {
        const response = await fetch(`${url}/api/status`, {
          signal: AbortSignal.timeout(1_000),
        }).catch(() => null);
        return response?.ok && (await response.json()).hasKey;
      }, { message: "UImaneger dev client and API are ready" }).toBe(true);

      await use({ url, sample, file, original, edited, requests });
    } finally {
      try {
        await Promise.all(Object.values(processes).map((process) => process.stop()));
      } finally {
        if (anthropic?.listening) await close(anthropic);
        // Windows ではプロセス終了直後もハンドルの解放が遅れることがある。
        await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        if (testInfo.status !== testInfo.expectedStatus) {
          for (const [name, process] of Object.entries(processes)) {
            await testInfo.attach(`${name}.log`, { body: process.logs(), contentType: "text/plain" });
          }
        }
      }
    }
  },
});
