import { useEffect, useRef, useState } from "react";

interface Props {
  diff: string;
  relFile?: string;
  confidence?: "high" | "medium" | "low";
  busy?: boolean;
  onApply: () => void;
  onReject: () => void;
}

const confLabel: Record<string, string> = {
  high: "確度: 高",
  medium: "確度: 中",
  low: "確度: 低",
};
const confColor: Record<string, string> = {
  high: "text-green-400",
  medium: "text-amber-400",
  low: "text-red-400",
};

/** unified diff を色分け表示し、承認/却下する。 */
export function DiffView({
  diff,
  relFile,
  confidence,
  busy,
  onApply,
  onReject,
}: Props) {
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lines = diff.split("\n");

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, []);

  function copyDiff() {
    const writeText =
      typeof navigator !== "undefined" ? navigator.clipboard?.writeText : null;
    if (!writeText) return;
    writeText
      .call(navigator.clipboard, diff)
      .then(() => {
        setCopied(true);
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimeoutRef.current = null;
        }, 1500);
      })
      .catch(() => {});
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-neutral-700 bg-neutral-900 p-2">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate text-neutral-300">{relFile}</span>
        <div className="flex shrink-0 items-center gap-2">
          {confidence && (
            <span className={confColor[confidence]}>
              {confLabel[confidence]}
            </span>
          )}
          <button
            type="button"
            aria-label="diff をコピー"
            onClick={copyDiff}
            className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-300 hover:bg-neutral-700"
          >
            {copied ? "コピー済" : "コピー"}
          </button>
        </div>
      </div>

      <pre className="max-h-64 overflow-auto rounded bg-neutral-950 p-2 text-[11px] leading-relaxed">
        {lines.map((ln, i) => {
          let cls = "text-neutral-400";
          if (ln.startsWith("+") && !ln.startsWith("+++"))
            cls = "bg-green-950 text-green-300";
          else if (ln.startsWith("-") && !ln.startsWith("---"))
            cls = "bg-red-950 text-red-300";
          else if (ln.startsWith("@@")) cls = "text-cyan-400";
          else if (ln.startsWith("+++") || ln.startsWith("---"))
            cls = "text-neutral-500";
          return (
            <div key={i} className={cls}>
              {ln || " "}
            </div>
          );
        })}
      </pre>

      <div className="flex gap-2">
        <button
          onClick={onApply}
          disabled={busy}
          className="flex-1 rounded bg-green-600 py-1 text-sm font-medium hover:bg-green-500 disabled:opacity-50"
        >
          承認して適用
        </button>
        <button
          onClick={onReject}
          disabled={busy}
          className="flex-1 rounded bg-neutral-700 py-1 text-sm hover:bg-neutral-600 disabled:opacity-50"
        >
          却下
        </button>
      </div>
    </div>
  );
}
