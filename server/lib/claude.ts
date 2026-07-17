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

export interface CompleteOpts {
  model?: string;
  system?: string;
  maxTokens?: number;
  allowTruncated?: boolean;
}

const TRUNCATED_MESSAGE =
  "max_tokens に到達したため応答が切り詰められました。ファイルが大きすぎる可能性があります。";

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

function extractText(
  content: Array<{ type: string; text?: string }>,
  stopReason: string | null,
  allowTruncated: boolean | undefined
): string {
  const block = content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text || "" : "";
  if (stopReason === "max_tokens" && !allowTruncated) {
    throw new TruncatedError(TRUNCATED_MESSAGE);
  }
  return text;
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
  return extractText(res.content, res.stop_reason, opts.allowTruncated);
}

/** ストリーミング補完。進捗を最大約 150ms ごとに通知し、最終メッセージの text を返す。 */
export async function streamComplete(
  prompt: string,
  opts: CompleteOpts & { adaptive?: boolean } = {},
  onProgress?: (info: { chars: number; tail: string }) => void
): Promise<string> {
  const c = getClient();
  const stream = c.messages.stream({
    model: opts.model || env.editModel,
    max_tokens: opts.maxTokens ?? 64000,
    system: opts.system,
    messages: [{ role: "user", content: prompt }],
    ...(opts.adaptive ? { thinking: { type: "adaptive" as const } } : {}),
  });

  let accumulated = "";
  let lastProgressAt = 0;
  let lastReported: string | undefined;
  stream.on("text", (delta) => {
    accumulated += delta;
    const now = Date.now();
    if (onProgress && now - lastProgressAt >= 150) {
      lastProgressAt = now;
      lastReported = accumulated;
      onProgress({
        chars: accumulated.length,
        tail: accumulated.slice(-120),
      });
    }
  });

  const final = await stream.finalMessage();
  if (onProgress && lastReported !== accumulated) {
    onProgress({
      chars: accumulated.length,
      tail: accumulated.slice(-120),
    });
  }
  return extractText(final.content, final.stop_reason, opts.allowTruncated);
}

/**
 * ```lang ... ``` で囲まれたコードブロックがあれば中身だけ取り出す。
 * 前置きテキストがあっても最初の開きフェンスから最後の閉じフェンスまでを抽出し、
 * 閉じフェンスは行頭の ``` のみ認識する。
 * フェンスが無ければ入力を trim して返す(既存挙動)。
 */
export function stripCodeFence(text: string): string {
  const m = text.match(
    /```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*)^```[ \t]*\r?\n?$/m
  );
  if (!m) return text.trim();
  return m[1].replace(/\r?\n$/, "");
}
