import { useEffect, useState } from "react";
import { api, type StatusResp } from "../lib/api.ts";

/** エラーログを分類して分かりやすい日本語ヒントにする。 */
function classify(logs: string[]): string | null {
  const text = logs.join("\n").toLowerCase();
  if (!text) return null;
  if (text.includes("eaddrinuse") || text.includes("port") && text.includes("use"))
    return "ポートが使用中です。別プロセスを停止するか再起動してください。";
  if (text.includes("command not found") || text.includes("enoent"))
    return "起動コマンドが見つかりません。対象プロジェクトの依存をインストールしてください。";
  if (text.includes("cannot find module") || text.includes("module not found"))
    return "依存が不足しています。対象プロジェクトで npm install 等を実行してください。";
  if (text.includes("error") && text.includes("install"))
    return "依存のインストールに失敗した可能性があります。";
  return null;
}

export function StatusPanel() {
  const [st, setSt] = useState<StatusResp | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .status()
        .then((s) => alive && setSt(s))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const info = st?.info;
  const logs = st?.logs ?? [];
  const hint = classify(logs);

  const gitModeLabel: Record<string, string> = {
    worktree: "git worktree",
    snapshot: "スナップショット",
    none: "git無し",
  };

  return (
    <div className="border-t border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] text-neutral-400">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">ステータス</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${st?.hasKey ? "bg-green-500/10 text-green-400 ring-green-500/20" : "bg-red-500/10 text-red-400 ring-red-500/20"}`}>
          {st?.hasKey ? "API key OK" : "API key 未設定"}
        </span>
      </div>

      {info ? (
        <div className="space-y-0.5">
          <div>
            FW: <span className="text-neutral-300">{info.framework}</span>
            {info.gitMode && (
              <span className="ml-2">
                ({gitModeLabel[info.gitMode] ?? info.gitMode})
              </span>
            )}
          </div>
          <div>
            前: {info.beforeProxyPort ?? "—"} / 後: {info.afterProxyPort ?? "—"}{" "}
            <span className={info.running ? "text-green-400" : "text-neutral-500"}>
              {info.running ? "● running" : "○ stopped"}
            </span>
          </div>
        </div>
      ) : (
        <div className="text-neutral-600">プロジェクト未オープン</div>
      )}

      {hint && (
        <div className="mt-1 rounded bg-red-950/50 px-2 py-1 text-red-300">
          {hint}
        </div>
      )}

      {logs.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-neutral-400 transition-colors duration-150 hover:text-neutral-300">
            起動ログ ({logs.length})
          </summary>
          <pre className="mt-1 max-h-28 overflow-auto rounded bg-black/40 p-1 text-[10px] text-neutral-500">
            {logs.slice(-12).join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
