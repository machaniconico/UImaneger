import { resolve } from "node:path";
import { parsePort, readDotEnvFile } from "./dotenv.ts";

export { parsePort };

// .env から process.env へ注入したキー。子プロセスへは渡さない(child-env.ts)。
export const dotenvInjectedKeys: string[] = [];

function loadDotEnv() {
  const values = readDotEnvFile(resolve(process.cwd(), ".env"));
  for (const [key, val] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = val;
      dotenvInjectedKeys.push(key);
    }
  }
}

loadDotEnv();

export const env = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  editModel: process.env.UIM_EDIT_MODEL || "claude-opus-4-8",
  serverPort: parsePort(process.env.UIM_SERVER_PORT, 5174, "UIM_SERVER_PORT"),
  clientPort: parsePort(process.env.UIM_CLIENT_PORT, 5173, "UIM_CLIENT_PORT"),
  workspacesDir: process.env.UIM_WORKSPACES_DIR || "./workspaces",
};
