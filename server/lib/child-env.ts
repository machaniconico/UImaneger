import { dotenvInjectedKeys } from "./env.ts";
import { foldEnvKey } from "./dotenv.ts";

// 子プロセス(対象 dev サーバ・git・依存インストール等)へ渡す環境変数を組み立てる。
// UImaneger 自身の秘密(ANTHROPIC_* / UIM_*)と .env から注入したキーは渡さない。
// extra は呼び出し側が明示した値なので後勝ちで残し、フィルタしない。
const STRIPPED_KEY = /^(ANTHROPIC_|UIM_)/i;

export function buildChildEnv(
  extra: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
  dotenvKeys: readonly string[] = dotenvInjectedKeys,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const normalizeKey = platform === "win32" ? foldEnvKey : (key: string) => key;
  const dropped = new Set(dotenvKeys.map(normalizeKey));
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (STRIPPED_KEY.test(key) || dropped.has(normalizeKey(key))) continue;
    result[key] = value;
  }
  if (platform === "win32") {
    // Windows の環境変数は大小無視。PATH と Path が両方残ると extra が負けるので統合する。
    const extraKeys = new Set(Object.keys(extra).map(foldEnvKey));
    for (const key of Object.keys(result)) {
      if (extraKeys.has(foldEnvKey(key))) delete result[key];
    }
  }
  return Object.assign(result, extra);
}
