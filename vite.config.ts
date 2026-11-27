import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { foldEnvKey, parsePort, readDotEnvFile } from "./server/lib/dotenv.ts";

/**
 * API サーバ(server/lib/env.ts)と同じ規則でポートを決める:
 * process.env を優先し、未定義なら .env の値、それも無ければ既定値。
 */
export function resolveDevPorts(
  base: NodeJS.ProcessEnv = process.env,
  envFile: string = resolve(process.cwd(), ".env"),
  platform: NodeJS.Platform = process.platform
): { serverPort: number; clientPort: number } {
  const dotenv = readDotEnvFile(envFile);
  function lookup(values: NodeJS.ProcessEnv, key: string): string | undefined {
    if (platform !== "win32") return values[key];
    const foldedKey = foldEnvKey(key);
    return Object.entries(values).find(([name, value]) =>
      value !== undefined && foldEnvKey(name) === foldedKey
    )?.[1];
  }
  const pick = (key: string) => lookup(base, key) ?? lookup(dotenv, key);
  return {
    serverPort: parsePort(pick("UIM_SERVER_PORT"), 5174, "UIM_SERVER_PORT"),
    clientPort: parsePort(pick("UIM_CLIENT_PORT"), 5173, "UIM_CLIENT_PORT"),
  };
}

const { serverPort, clientPort } = resolveDevPorts();

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: clientPort,
    strictPort: true,
    // Vite 既定の CORS は任意ポートの localhost origin を許可するため無効化する
    // (UI は同一 origin で動くので CORS ヘッダは不要)。
    cors: false,
    // ブラウザの Host をそのまま転送し、Vite 経由でも API 側の Host 検査を適用する。
    proxy: {
      "/api": {
        target: `http://localhost:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
});
