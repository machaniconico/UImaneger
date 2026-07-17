import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import type { HistoryEntry } from "../lib/types.ts";

const kindIcon: Record<HistoryEntry["kind"], string> = {
  apply: "✓",
  undo: "↩",
  redo: "↪",
};

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--";
  return `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes()
  ).padStart(2, "0")}`;
}

export function HistoryPanel() {
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const refresh = useCallback(() => {
    api
      .editHistory()
      .then((res) => setHistory(res.history))
      .catch(() => {});
  }, []);

  useEffect(() => {
    window.addEventListener("uim:applied", refresh);
    return () => window.removeEventListener("uim:applied", refresh);
  }, [refresh]);

  return (
    <details
      className="border-t border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] text-neutral-400"
      onToggle={(event) => {
        if (event.currentTarget.open) refresh();
      }}
    >
      <summary className="cursor-pointer font-semibold text-neutral-300">
        編集履歴
      </summary>
      <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
        {history.length === 0 ? (
          <div className="text-neutral-600">まだ編集はありません</div>
        ) : (
          history.map((entry) => (
            <div key={entry.id} className="flex items-start gap-1.5">
              <span className="shrink-0 text-neutral-300">
                {kindIcon[entry.kind]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-neutral-300" title={entry.relFile}>
                    {fileName(entry.relFile)}
                  </span>
                  <time className="shrink-0 text-neutral-600" dateTime={entry.appliedAt}>
                    {formatTime(entry.appliedAt)}
                  </time>
                </div>
                {entry.summary && (
                  <div className="truncate text-neutral-500">{entry.summary}</div>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </details>
  );
}
