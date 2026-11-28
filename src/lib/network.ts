/** サーバ(npm run dev)に届かないときの案内文。 */
export const SERVER_UNREACHABLE_MESSAGE =
  "サーバに接続できません。`npm run dev` が動いているか確認してください";

/** fetch が通信できなかったときの例外(ブラウザ差を吸収して判定する)。 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return false;
  if (error instanceof TypeError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
}
