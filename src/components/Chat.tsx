import { useEffect, useRef, useState } from "react";
import type {
  Candidate,
  DomDescriptor,
  EditProposal,
} from "../lib/types.ts";
import { api } from "../lib/api.ts";
import type { EditModel } from "../lib/api.ts";
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
  selectionModeActive?: boolean;
  onDeselect?: () => void;
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

export function Chat({
  selected,
  hasKey,
  selectionModeActive = false,
  onDeselect,
}: Props) {
  const [instruction, setInstruction] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<EditProposal | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [lastInstruction, setLastInstruction] = useState("");
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [editModels, setEditModels] = useState<EditModel[]>([]);
  const [editModel, setEditModel] = useState("");
  const editModelRef = useRef("");
  const logRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [generation, setGeneration] = useState<{
    stage: "resolving" | "generating";
    file?: string;
    chars?: number;
    tail?: string;
  } | null>(null);
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
      .getModels()
      .then(({ models, default: defaultModel }) => {
        if (!alive) return;
        const stored = localStorage.getItem("uim:edit-model");
        const selectedModel =
          stored && models.some((model) => model.id === stored)
            ? stored
            : defaultModel;
        localStorage.setItem("uim:edit-model", selectedModel);
        editModelRef.current = selectedModel;
        setEditModels(models);
        setEditModel(selectedModel);
      })
      .catch(() => {
        if (alive) {
          editModelRef.current = "";
          setEditModels([]);
          setEditModel("");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .status()
      .then((s) => {
        if (alive) {
          setUndoDepth(s.undoDepth ?? 0);
          setRedoDepth(s.redoDepth ?? 0);
        }
      })
      .catch(() => {
        if (alive) {
          setUndoDepth(0);
          setRedoDepth(0);
        }
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

  async function refreshDepths() {
    const s = await api.status();
    setUndoDepth(s.undoDepth ?? 0);
    setRedoDepth(s.redoDepth ?? 0);
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
    const previousProposal = proposal;
    const previousEditDescriptor = editDescriptor;
    setInstruction("");
    setLastInstruction(text);
    setEditDescriptor(selected);
    const previousProposalId =
      proposal?.proposalId &&
      editDescriptor &&
      sameDescriptor(editDescriptor, selected)
        ? proposal.proposalId
        : undefined;
    setProposal(null);
    setCandidates([]);
    log({ role: "user", text });
    setBusy(true);
    setGeneration({ stage: "resolving" });
    try {
      const result = await api.editStream(
        {
          descriptor: selected,
          instruction: text,
          ...(previousProposalId ? { previousProposalId } : {}),
          ...(editModelRef.current ? { model: editModelRef.current } : {}),
        },
        {
          onStage: ({ stage, file }) =>
            setGeneration((current) => ({
              stage,
              file,
              chars: stage === "generating" ? current?.chars : undefined,
              tail: stage === "generating" ? current?.tail : undefined,
            })),
          onProgress: ({ chars, tail }) =>
            setGeneration((current) => ({
              stage: "generating",
              file: current?.file,
              chars,
              tail,
            })),
        }
      );
      handleProposal(result, text);
      if (!result.ok) {
        setProposal(previousProposal);
        if (previousProposal) setEditDescriptor(previousEditDescriptor);
      }
    } catch (e: any) {
      setInstruction(text);
      setProposal(previousProposal);
      if (previousProposal) setEditDescriptor(previousEditDescriptor);
      log({ role: "system", ok: false, text: "✗ " + String(e.message || e) });
    } finally {
      setGeneration(null);
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
        setRedoDepth(0);
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
        setRedoDepth((depth) => res.redoDepth ?? depth + 1);
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

  async function redo() {
    if (busy || redoDepth <= 0) return;
    setBusy(true);
    try {
      const res = await api.redoEdit();
      if (res.ok) {
        log({
          role: "system",
          ok: true,
          text: `↪ ${res.relFile || ""} をやり直しました`,
        });
        window.dispatchEvent(new CustomEvent("uim:applied"));
        setUndoDepth((depth) => res.undoDepth ?? depth + 1);
        setRedoDepth(res.redoDepth ?? 0);
      } else {
        log({ role: "system", ok: false, text: "✗ " + (res.error || "redo失敗") });
        await refreshDepths().catch((statusError) => {
          console.error(statusError);
        });
      }
    } catch (e: any) {
      log({ role: "system", ok: false, text: "✗ " + String(e.message || e) });
      await refreshDepths().catch((statusError) => {
        console.error(statusError);
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      const target = event.target as HTMLElement | null;
      const isTextInput = Boolean(
        target &&
          (target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable)
      );
      const isModifierEnter =
        event.key === "Enter" && (event.metaKey || event.ctrlKey);

      if (isModifierEnter && target === textareaRef.current) {
        event.preventDefault();
        if (instruction.trim()) void send();
        else if (proposal?.diff) void apply();
        return;
      }
      if (isTextInput) return;
      if (isModifierEnter && selected && proposal?.diff) {
        event.preventDefault();
        void apply();
      } else if (
        event.key === "Escape" &&
        (selectionModeActive || selected)
      ) {
        event.preventDefault();
        onDeselect?.();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-sm font-semibold">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0">自然言語で編集</span>
          {editModels.length > 0 && editModel && (
            <select
              aria-label="編集モデル"
              value={editModel}
              onChange={(event) => {
                const model = event.target.value;
                editModelRef.current = model;
                setEditModel(model);
                localStorage.setItem("uim:edit-model", model);
              }}
              className="h-5 min-w-0 max-w-28 rounded-md border border-neutral-700 bg-neutral-900 px-1.5 text-xs font-normal text-neutral-300 outline-none transition-colors duration-150 hover:border-neutral-600 focus:border-accent-500 focus:ring-1 focus:ring-accent-500/30"
            >
              {editModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label} · {model.note}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-1">
          {undoDepth > 0 && (
            <button
              type="button"
              onClick={undo}
              disabled={busy}
              className="cursor-pointer rounded-md border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition-colors duration-150 hover:border-neutral-600 hover:bg-neutral-700 disabled:cursor-default disabled:opacity-50"
            >
              ↩ undo ({undoDepth})
            </button>
          )}
          {redoDepth > 0 && (
            <button
              type="button"
              onClick={redo}
              disabled={busy}
              className="cursor-pointer rounded-md border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition-colors duration-150 hover:border-neutral-600 hover:bg-neutral-700 disabled:cursor-default disabled:opacity-50"
            >
              ↪ redo ({redoDepth})
            </button>
          )}
        </div>
      </div>

      {/* 選択中の要素 */}
      <div className="border-b border-neutral-800 px-3 py-2 text-xs">
        {selected ? (
          <div className="space-y-1.5 rounded-lg border border-neutral-800 bg-neutral-900 p-2.5 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="truncate font-mono text-accent-300">
                &lt;{selected.tag}
                {selected.id ? ` #${selected.id}` : ""}&gt;
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                  selected.source
                    ? "bg-green-500/10 text-green-400 ring-1 ring-inset ring-green-500/20"
                    : "bg-cyan-500/10 text-cyan-400 ring-1 ring-inset ring-cyan-500/20"
                }`}
              >
                {selected.source ? "層A" : "層B"}
              </span>
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
            <div className="text-[10px] text-neutral-500">
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
                  ? "ml-8 rounded-lg rounded-br-sm bg-neutral-800 px-2.5 py-1.5 text-neutral-200"
                  : m.ok === true
                  ? "mr-8 rounded-lg rounded-bl-sm bg-green-500/10 px-2.5 py-1.5 text-green-400"
                  : m.ok === false
                  ? "mr-8 rounded-lg rounded-bl-sm bg-red-500/10 px-2.5 py-1.5 text-red-400"
                  : "mr-8 rounded-lg rounded-bl-sm bg-neutral-900 px-2.5 py-1.5 text-neutral-400"
              }
            >
              {m.text}
            </div>
          ))}
        </div>
        {generation ? (
          <div
            role="status"
            className="mr-8 rounded-lg rounded-bl-sm bg-neutral-900 px-2.5 py-2 text-neutral-500"
          >
            <div>
              {generation.stage === "resolving"
                ? "解決中…"
                : `生成中: ${generation.file ?? ""}${
                    generation.chars != null
                      ? ` (${generation.chars}文字)`
                      : ""
                  }`}
            </div>
            <div className="h-4 truncate font-mono text-xs text-neutral-600">
              {generation.tail ?? ""}
            </div>
          </div>
        ) : busy ? (
          <div
            role="status"
            className="mr-8 flex items-center gap-1 rounded-lg rounded-bl-sm bg-neutral-900 px-2.5 py-2 text-neutral-500"
          >
            <span className="sr-only">処理中…</span>
            {[0, 1, 2].map((index) => (
              <span
                key={index}
                className="h-1.5 w-1.5 animate-bounce rounded-full bg-neutral-500 motion-reduce:animate-none"
                style={{ animationDelay: `${index * 120}ms` }}
              />
            ))}
          </div>
        ) : null}

        {hasPendingSuggestion && editDescriptor && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-2 text-xs text-neutral-400">
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
        {proposal?.diff && (
          <div className="mb-1 text-xs text-neutral-500">
            続けて指示すると提案を追い込めます（例: もっと大きく）
          </div>
        )}
        <div className="overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 transition-colors duration-150 focus-within:border-accent-500 focus-within:ring-2 focus-within:ring-accent-500/30">
          <textarea
            ref={textareaRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            aria-label="編集指示"
            placeholder={
              selected
                ? "例: この見出しを大きく赤くして / 余白を広げて / 角を丸く"
                : "先に要素を選択"
            }
            disabled={!selected || busy}
            rows={3}
            className="w-full resize-none border-0 bg-transparent px-2.5 py-2 text-sm outline-none disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={!selected || busy || !instruction.trim()}
            className="w-full border-t border-accent-500/30 bg-accent-600 py-1.5 text-sm font-medium text-white transition-colors duration-150 hover:bg-accent-500 disabled:bg-neutral-800 disabled:text-neutral-500 disabled:opacity-70"
          >
            差分を生成 (⌘/Ctrl+Enter)
          </button>
        </div>
      </div>
    </div>
  );
}
