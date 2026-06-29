import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 依存を増やさない軽量 .env ローダ
function stripComment(value: string): string {
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if ((ch === '"' || ch === "'") && value[i - 1] !== "\\") {
      quote = quote === ch ? null : quote || ch;
      continue;
    }
    if (ch === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] || ""))) {
      return value.slice(0, i);
    }
  }
  return value;
}

function loadDotEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/i);
      if (!m) continue;
      const key = m[1];
      let val = stripComment(m[2]).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    // .env が無くても可
  }
}

loadDotEnv();

export const env = {
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  editModel: process.env.UIM_EDIT_MODEL || "claude-opus-4-8",
  serverPort: Number(process.env.UIM_SERVER_PORT || "5174"),
  clientPort: Number(process.env.UIM_CLIENT_PORT || "5173"),
  workspacesDir: process.env.UIM_WORKSPACES_DIR || "./workspaces",
};
