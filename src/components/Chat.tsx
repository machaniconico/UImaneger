import { useEffect, useRef, useState } from "react";
import type {
  Candidate,
  DomDescriptor,
  EditProposal,
} from "../lib/types.ts";
import { api } from "../lib/api.ts";
import { DiffView } from "./DiffView.tsx";
import { Candidates } from "./Candidates.tsx";

interface Msg {
  role: "user" | "system";
  text: string;
  ok?: boolean;
}

interface Props {
  selected: DomDescriptor | null;
  hasKey: boolean;
}

function descriptorLabel(d: DomDescriptor) {
  return `<${d.tag}${d.id ? ` #${d.id}` : ""}>${
    d.textSnippet ? ` "${d.textSnippet}"` : ""
  }`;
}

function sameDescriptor(a: DomDescriptor, b: DomDescriptor) {
  return (
    a.domPath === b.domPath &&
    a.tag === b.tag &&
    (a.id ?? "") === (b.id ?? "")
  );
}

export function Chat({ selected, hasKey }: Props) {
  const [instruction, setInstruction] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [lastInstruction, setLastInstruction] = useState("");
  const [undoDepth, setUndoDepth] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  // 提案/候補を生成した時点の要素を固定保持 (その後 selected が変わっても誤マッチを防ぐ)
  const [editDescriptor, setEditDescriptor] = useState<DomDescriptor | null>(
    null
  );
  const hasPendingSuggestion =
    candidates.length > 0 || Boolean(proposal && proposal.diff);
  const descriptorMismatch = Boolean(
    hasPendingSuggestion &&
      editDescriptor &&
      selected &&
      !sameDescriptor(editDescriptor, selected)
  );

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, busy, proposal, candidates]);

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((s) => {
        if (alive) setUndoDepth(s.undoDepth ?? 0);
      })
      .catch(() => {
        if (alive) setUndoDepth(0);
      });
    return () => {
      alive = false;
    };
  }, []);

  function log(m: Msg) {
    setMsgs((prev) => [...prev, m]);
  }

  async function refreshUndoDepth() {
    const s = await api.status();
    setUndoDepth(s.undoDepth ?? 0);
  }

  function handleProposal(res: EditProposal, originalText?: string) {
    if (res.ok && res.proposalId && res.diff) {
      setProposal(res);
      setCandidates(res.candidates ?? []);
      log({
        role: "system",
        text: "差分の準備ができました。承認または却下してください。",
      });
    } else if (res.candidates && res.candidates.length) {
      setProposal(null);
      setCandidates(res.candidates);
      log({ role: "system", ok: false, text: "候補から選んでください。" });
    } else {
      setProposal(null);
      setCandidates([]);
      if (originalText) setInstruction(originalText);
      log({
        role: "system",
        ok: false,
        text: "✗ " + (res.error || res.summary || "提案を作成できませんでした"),
      });
    }
  }

  async function send() {
    const text = instruction.trim();
    if (!text || !selected || busy) return;
    setInstruction("");
    setLastInstruction(text);
    setEditDescriptor(selected);
    setProposal(null);
    setCandidates([]);
    log({ role: "user", text });
    setBusy(true);
    try {
      handleProposal(await api.edit(selected, text), text);
    } catch (e: any) {
      setInstruction(text);
      log({ role: "system", ok: false, text: "✗ " + String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function pickCandidate(c: Candidate) {
    const desc = editDescriptor ?? selected;
    if (!desc || busy) return;
    setBusy(true);
    try {
      handleProposal(
        await api.editCandidate(c, desc, lastInstruction),
        lastInstruction
      );
    } catch (e: any) {
      log({ role: "system", ok: false, text: "✗ " + String(e.message || e) });
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal?.proposalId || busy) return;
    setBusy(true);
    try {
      const res = await api.applyEdit(proposal.proposalId);
      if (res.ok) {
        log({
          role: "system",
          ok: true,
          text: `✓ ${res.relFile || proposal.relFile} に適用しました`,
        });
        setUndoDepth((depth) => res.undoDepth ?? depth + 1);
        window.dispatchEvent(new CustomEvent("uim:applied"));
        setProposal(null);
        setCandidates([]);
      } else {
        log({ role: "system", ok: false, text: "✗ " + (res.error || "適用失敗") });
        // proposal を保持したまま → 再試行可能
      }
    } catch (e: any) {
      log({ role: "system", ok: false, text: "✗ " + String(e.message || e) });
      // proposal を保持したまま → 再試行可能
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (busy) return; // apply とのレースを防ぐ
    setBusy(true);
    try {
      if (proposal?.proposalId) {
        await api.rejectEdit(proposal.proposalId).catch(() => {});
      }
      setProposal(null);
      setCandidates([]);
      log({ role: "system", text: "提案を却下しました" });
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (busy || undoDepth <= 0) return;
    setBusy(true);
    try {
      const res = await api.undoEdit();
      if (res.ok) {
        log({
          role: "system",
          ok: true,
          text: `↩ ${res.relFile || ""} を元に戻しました`,
        });
        window.dispatchEvent(new CustomEvent("uim:applied"));
        setUndoDepth(res.undoDepth ?? 0);
      } else {
        log({ role: "system", ok: false, text: "✗ " + (res.error || "undo失敗") });
        if (res.undoDepth != null) {
          setUndoDepth(res.undoDepth);
        } else {
          await refreshUndoDepth().catch((statusError) => {
            console.error(statusError);
          });
        }
      }
    } catch (e: any) {
      log({ role: "system", ok: false, text: "✗ " + String(e.message || e) });
      await refreshUndoDepth().catch((statusError) => {
        console.error(statusError);
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-sm font-semibold">
        <span>自然言語で編集</span>
        {undoDepth > 0 && (
          <button
            type="button"
            onClick={undo}
            disabled={busy}
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs hover:bg-neutral-700 disabled:opacity-50"
          >
            ↩ undo ({undoDepth})
          </button>
        )}
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
                ? `層A: ${selected.source.fileName
                    .split(/[\\/]/)
                    .slice(-1)}:${selected.source.lineNumber}`
                : "層B: 特徴検索で解決"}
            </div>
          </div>
        ) : (
          <div className="text-neutral-500">
            「要素を選択」で対象をクリックしてください
          </div>
        )}
      </div>

      {/* ログ + 提案 */}
      <div
        ref={logRef}
        className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm"
      >
        <div
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          className="space-y-2"
        >
          {msgs.map((m, i) => (
            <div
              key={i}
              className={
                m.role === "user"
                  ? "rounded bg-neutral-800 px-2 py-1"
                  : m.ok === true
                  ? "text-green-400"
                  : m.ok === false
                  ? "text-red-400"
                  : "text-neutral-500"
              }
            >
              {m.text}
            </div>
          ))}
        </div>
        {busy && (
          <div role="status" className="text-neutral-500">
            処理中…
          </div>
        )}

        {hasPendingSuggestion && editDescriptor && (
          <div className="rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-400">
            <div>提案対象: {descriptorLabel(editDescriptor)}</div>
            {descriptorMismatch && (
              <div className="mt-1 text-amber-300">
                この差分は別の選択要素のものです
              </div>
            )}
          </div>
        )}

        {candidates.length > 0 && (
          <Candidates candidates={candidates} busy={busy} onPick={pickCandidate} />
        )}

        {proposal && proposal.diff && (
          <DiffView
            diff={proposal.diff}
            relFile={proposal.relFile}
            confidence={proposal.confidence}
            busy={busy}
            onApply={apply}
            onReject={reject}
          />
        )}
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
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          aria-label="編集指示"
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
          差分を生成 (⌘/Ctrl+Enter)
        </button>
      </div>
    </div>
  );
}
