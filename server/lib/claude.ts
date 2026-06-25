import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.ts";

let client: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!env.anthropicKey) {
    throw new Error(
      "ANTHROPIC_API_KEY が未設定です。.env に設定してください (.env.example 参照)。"
    );
  }
  if (!client) client = new Anthropic({ apiKey: env.anthropicKey });
  return client;
}

export function hasKey(): boolean {
  return Boolean(env.anthropicKey);
}

interface CompleteOpts {
  model?: string;
  system?: string;
  maxTokens?: number;
}

/** 単純なテキスト補完。最初の text ブロックを返す。 */
export async function complete(
  prompt: string,
  opts: CompleteOpts = {}
): Promise<string> {
  const c = getClient();
  const res = await c.messages.create({
    model: opts.model || env.editModel,
    max_tokens: opts.maxTokens ?? 8000,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
  });
  const block = res.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text : "";
}

/** ```lang ... ``` で囲まれたコードブロックがあれば中身だけ取り出す。無ければそのまま。 */
export function stripCodeFence(text: string): string {
  const m = text.match(/^\s*```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : text.trim();
}
