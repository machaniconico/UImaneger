import { useState } from "react";
import type { DomDescriptor, EditResult } from "../lib/types.ts";
import { api } from "../lib/api.ts";

interface Msg {
  role: "user" | "system";
  text: string;
  ok?: boolean;
}

interface Props {
  selected: DomDescriptor | null;
  hasKey: boolean;
}

export function Chat({ selected, hasKey }: Props) {
  const [instruction, setInstruction] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);

  async function send() {
    const text = instruction.trim();
    if (!text || !selected || busy) return;
    setInstruction("");
    setMsgs((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res: EditResult = await api.edit(selected, text);
      if (res.ok) {
        setMsgs((m) => [
          ...m,
          {
            role: "system",
            ok: true,
            text: `✓ ${res.summary} (${res.relFile}${
              res.line ? ":" + res.line : ""
            } / 確度:${res.confidence})`,
          },
        ]);
      } else {
        setMsgs((m) => [
          ...m,
          { role: "system", ok: false, text: `✗ ${res.error || res.summary}` },
        ]);
      }
    } catch (e: any) {
      setMsgs((m) => [
        ...m,
        { role: "system", ok: false, text: "✗ " + String(e.message || e) },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-200">
      <div className="border-b border-neutral-800 px-3 py-2 text-sm font-semibold">
        自然言語で編集
      </div>

      {/* 選択中の要素 */}
      <div className="border-b border-neutral-800 px-3 py-2 text-xs">
        {selected ? (
          <div className="space-y-1">
            <div className="text-blue-400">
              &lt;{selected.tag}
              {selected.id ? ` #${selected.id}` : ""}&gt;
            </div>
            {selected.textSnippet && (
              <div className="truncate text-neutral-400">
                “{selected.textSnippet}”
              </div>
            )}
            {selected.classes.length > 0 && (
              <div className="truncate text-neutral-500">
                .{selected.classes.join(" .")}
              </div>
            )}
            <div className="text-neutral-600">
              {selected.source
                ? `層A: ${selected.source.fileName.split("/").slice(-1)}:${
                    selected.source.lineNumber
                  }`
                : "層B: 特徴検索で解決"}
            </div>
          </div>
        ) : (
          <div className="text-neutral-500">
            「要素を選択」で対象をクリックしてください
          </div>
        )}
      </div>

      {/* ログ */}
      <div className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={
              m.role === "user"
                ? "rounded bg-neutral-800 px-2 py-1"
                : m.ok
                ? "text-green-400"
                : "text-red-400"
            }
          >
            {m.text}
          </div>
        ))}
        {busy && <div className="text-neutral-500">編集中…</div>}
      </div>

      {/* 入力 */}
      <div className="border-t border-neutral-800 p-2">
        {!hasKey && (
          <div className="mb-1 text-xs text-red-400">
            ANTHROPIC_API_KEY を .env に設定してください
          </div>
        )}
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
          placeholder={
            selected
              ? "例: この見出しを大きく赤くして / 余白を広げて / 角を丸く"
              : "先に要素を選択"
          }
          disabled={!selected || busy}
          rows={3}
          className="w-full resize-none rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm outline-none focus:border-blue-500 disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={!selected || busy || !instruction.trim()}
          className="mt-1 w-full rounded bg-blue-600 py-1 text-sm font-medium hover:bg-blue-500 disabled:opacity-50"
        >
          編集 (⌘/Ctrl+Enter)
        </button>
      </div>
    </div>
  );
}
