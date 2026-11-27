import { readFileSync } from "node:fs";

/** 環境変数名の ASCII 英字を小文字にそろえる。 */
export function foldEnvKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

// 依存を増やさない軽量 .env パーサ(副作用なし)。server/lib/env.ts と vite.config.ts で共有する。
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

/** .env ファイルを読み、キーと値の組を返す。無ければ空。 */
export function readDotEnvFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return result; // .env が無くても可
  }
  // CRLF の .env(Windows のエディタ既定)でも行末の \r を残さない。`.` は \r に一致しないため行全体が不一致になっていた。
  for (const line of raw.split(/\r?\n/)) {
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
    if (!(key in result)) result[key] = val; // 重複キーは先勝ち(従来の process.env 注入と同じ)
  }
  return result;
}

/**
 * ポート設定値を検証する。空/undefined なら fallback、それ以外は
 * 1〜65535 の整数でなければ日本語メッセージで throw する(起動時に即時失敗)。
 */
export function parsePort(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined) return fallback;
  const value = raw.trim();
  if (value === "") return fallback;
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `${name} に無効なポートが指定されました: ${raw} (1〜65535 の整数で指定してください)`
    );
  }
  return n;
}
