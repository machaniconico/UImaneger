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
  allowTruncated?: boolean;
}

/**
 * max_tokens に到達し応答が切り詰められた場合に投げる例外。
 * complete の戻り値型(Promise<string>)を維持しつつ、呼び出し側へ切り詰めを伝える。
 */
export class TruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TruncatedError";
  }
}

/** 単純なテキスト補完。最初の text ブロックを返す。切り詰め時は TruncatedError を投げる。 */
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
  const text = block && block.type === "text" ? block.text : "";
  if (res.stop_reason === "max_tokens" && !opts.allowTruncated) {
    throw new TruncatedError(
      "max_tokens に到達したため応答が切り詰められました。ファイルが大きすぎる可能性があります。"
    );
  }
  return text;
}

/**
 * ```lang ... ``` で囲まれたコードブロックがあれば中身だけ取り出す。
 * 前置きテキストがあっても最初のコードブロックを抽出し、
 * 閉じフェンスは行頭の ``` のみ認識する。
 * フェンスが無ければ入力を trim して返す(既存挙動)。
 */
export function stripCodeFence(text: string): string {
  const m = text.match(/```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)^```/m);
  if (!m) return text.trim();
  const extracted = m[1].replace(/\r?\n$/, "");
  const deviation = text.length - extracted.length;
  if (deviation > 200 && extracted.length < text.length * 0.5) return text;
  return extracted;
}
