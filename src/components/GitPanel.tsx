import { useEffect, useMemo, useRef, useState } from "react";
import { api, getErrorMessage } from "../lib/api.ts";
import type { ProjectInfo } from "../lib/types.ts";

interface Props {
  info: ProjectInfo | null;
}

function parseChange(change: string): { code: string; path: string } {
  const normalized = change.replace(/\0/g, "");
  return {
    code: normalized.slice(0, 2).trim() || "?",
    path: normalized.slice(3).trim() || normalized.trim(),
  };
}

export function GitPanel({ info }: Props) {
  const [changes, setChanges] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const requestIdRef = useRef(0);

  const root = info?.root ?? "";
  const available = Boolean(root && info?.gitMode !== "none");
  const parsedChanges = useMemo(() => changes.map(parseChange), [changes]);
  const hasChanges = parsedChanges.length > 0;
  const canCommit =
    available && hasChanges && message.trim().length > 0 && !loading && !committing;

  async function loadChanges(preserveNotice = false) {
    const requestId = ++requestIdRef.current;
    if (!available) {
      setChanges([]);
      setError("");
      setNotice("");
      return;
    }
    setLoading(true);
    setError("");
    if (!preserveNotice) setNotice("");
    try {
      const result = await api.gitStatus();
      if (requestId !== requestIdRef.current) return;
      setChanges(result.changes);
    } catch (e) {
      if (requestId !== requestIdRef.current) return;
      setChanges([]);
      setError(getErrorMessage(e));
    } finally {
      if (requestId !== requestIdRef.current) return;
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadChanges();
  }, [available, root]);

  useEffect(() => {
    const onApplied = () => {
      void loadChanges();
    };
    window.addEventListener("uim:applied", onApplied);
    return () => window.removeEventListener("uim:applied", onApplied);
  }, [available, root]);

  async function commit() {
    if (!canCommit) return;
    setCommitting(true);
    setError("");
    setNotice("");
    try {
      await api.gitCommit(message.trim());
      setMessage("");
      setNotice("コミットしました");
      await loadChanges(true);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setCommitting(false);
    }
  }

  return (
    <section className="border-t border-neutral-800 bg-neutral-950 text-xs text-neutral-300">
      <div className="flex items-center justify-between border-b border-neutral-900 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-semibold text-neutral-200">Git</span>
          {available && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
              {loading ? "確認中" : `${changes.length} changes`}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            void loadChanges();
          }}
          disabled={!available || loading || committing}
          className="rounded px-2 py-0.5 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
        >
          更新
        </button>
      </div>

      <div className="space-y-2 px-3 py-2">
        {!info && <div className="text-neutral-600">プロジェクト未オープン</div>}
        {info && info.gitMode === "none" && (
          <div className="text-neutral-600">Git なし</div>
        )}

        {available && error && (
          <div
            role="alert"
            className="whitespace-pre-wrap rounded bg-red-950/50 px-2 py-1 text-red-300"
          >
            {error}
          </div>
        )}
        {available && notice && !error && (
          <div className="rounded bg-green-950/40 px-2 py-1 text-green-300">
            {notice}
          </div>
        )}

        {available && !loading && !error && !hasChanges && (
          <div className="text-neutral-600">変更なし</div>
        )}

        {available && hasChanges && (
          <>
            <div className="max-h-24 overflow-auto rounded border border-neutral-800">
              {parsedChanges.slice(0, 8).map((change, index) => (
                <div
                  key={`${change.code}-${change.path}-${index}`}
                  className="grid grid-cols-[2.5rem_1fr] gap-2 border-b border-neutral-900 px-2 py-1 last:border-b-0"
                >
                  <span className="font-mono text-[10px] text-amber-300">
                    {change.code}
                  </span>
                  <span className="truncate font-mono text-[10px] text-neutral-400">
                    {change.path}
                  </span>
                </div>
              ))}
            </div>
            {parsedChanges.length > 8 && (
              <div className="text-neutral-600">
                他 {parsedChanges.length - 8} 件
              </div>
            )}
          </>
        )}

        {available && (
          <div className="space-y-1">
            <label className="block text-neutral-500" htmlFor="git-message">
              Commit message
            </label>
            <input
              id="git-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={!hasChanges || committing}
              className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-neutral-200 outline-none focus:border-blue-500 disabled:opacity-50"
            />
            <button
              type="button"
              onClick={commit}
              disabled={!canCommit}
              className="w-full rounded bg-neutral-700 py-1 font-medium text-neutral-100 hover:bg-neutral-600 disabled:opacity-40"
            >
              {committing ? "コミット中…" : "Commit"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
