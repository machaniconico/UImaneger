import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import type { HistoryEntry } from "../lib/types.ts";

const kindIcon: Record<HistoryEntry["kind"], string> = {
  apply: "✓",
  undo: "↩",
  redo: "↪",
};

const kindLabel: Record<HistoryEntry["kind"], string> = {
  apply: "適用",
  undo: "元に戻す",
  redo: "やり直し",
};

const kindColor: Record<HistoryEntry["kind"], string> = {
  apply: "text-green-400",
  undo: "text-amber-400",
  redo: "text-cyan-400",
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

interface Props {
  /** 開いているプロジェクトの root。変わったら前の履歴を捨てて取得し直す */
  root?: string;
}

export function HistoryPanel({ root }: Props) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);
  // 古いリクエストの遅い応答(切替前プロジェクトの履歴)で上書きしないための世代番号
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    const requestId = ++requestIdRef.current;
    api
      .editHistory()
      .then((res) => {
        if (requestId !== requestIdRef.current) return;
        setHistory(res.history);
        setOffline(false);
      })
      .catch(() => {
        if (requestId !== requestIdRef.current) return;
        // 古い履歴を出し続けない
        setHistory([]);
        setOffline(true);
      });
  }, []);

  const mountedRoot = useRef(root);
  useEffect(() => {
    if (mountedRoot.current === root) return;
    mountedRoot.current = root;
    requestIdRef.current++;
    setHistory([]);
    setOffline(false);
    if (open) refresh();
  }, [root, open, refresh]);

  useEffect(() => {
    window.addEventListener("uim:applied", refresh);
    return () => window.removeEventListener("uim:applied", refresh);
  }, [refresh]);

  return (
    <details
      className="border-t border-neutral-800 bg-neutral-950 px-3 py-2 text-[11px] text-neutral-400"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open) refresh();
      }}
    >
      <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wide text-neutral-400 transition-colors duration-150 hover:text-neutral-300">
        編集履歴
      </summary>
      <div className="mt-2 max-h-36 space-y-1 overflow-y-auto">
        {offline ? (
          <div role="alert" className="text-red-300">
            サーバに接続できません
          </div>
        ) : history.length === 0 ? (
          <div className="text-neutral-600">まだ編集はありません</div>
        ) : (
          history.map((entry) => (
            <div key={entry.id} className="flex items-start gap-1.5 rounded px-1 py-0.5 transition-colors duration-150 hover:bg-neutral-900">
              <span
                role="img"
                aria-label={kindLabel[entry.kind]}
                className={`shrink-0 font-semibold ${kindColor[entry.kind]}`}
              >
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
