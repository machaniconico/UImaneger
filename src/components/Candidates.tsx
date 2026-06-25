import type { Candidate } from "../lib/types.ts";

interface Props {
  candidates: Candidate[];
  busy?: boolean;
  onPick: (c: Candidate) => void;
}

/** 確度が低い/複数候補のとき、ソース候補をユーザーに選ばせる。 */
export function Candidates({ candidates, busy, onPick }: Props) {
  if (!candidates.length) return null;
  return (
    <div className="flex flex-col gap-1 rounded border border-amber-700/60 bg-amber-950/30 p-2 text-xs">
      <div className="text-amber-300">
        確定できませんでした。対象の箇所を選んでください:
      </div>
      <div className="flex flex-col gap-1">
        {candidates.map((c, i) => {
          const rel = c.file.split(/[\\/]/).slice(-2).join("/");
          return (
            <button
              key={i}
              onClick={() => onPick(c)}
              disabled={busy}
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-left hover:border-amber-500 disabled:opacity-50"
            >
              <div className="text-neutral-300">
                {rel}:{c.line}
              </div>
              <div className="truncate text-neutral-500">{c.preview}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
