// 外部依存なしの簡易 unified diff 生成器 (行ベース LCS)。
// GNU diff 互換の unified diff 文字列を返す。

export type DiffLineType = "context" | "remove" | "add";

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

const MAX_LCS_CELLS = 2_000_000;
const MAX_LCS_LINES = 20_000;

/** CRLF/CR を LF に正規化してから行配列へ。空文字列は空配列。末尾の空行は取り除く。 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** 末尾改行の有無(空文字列は改行無し扱いしない)。マーカー出力判定に使う。 */
function hasTrailingNewline(text: string): boolean {
  return text.length > 0 && /[\r\n]$/.test(text);
}

function fullReplacementDiff(a: string[], b: string[]): DiffLine[] {
  return [
    ...a.map((text) => ({ type: "remove" as const, text })),
    ...b.map((text) => ({ type: "add" as const, text })),
  ];
}

function createTrailingNewlineOnlyDiff(
  originalLines: string[],
  oldNoNL: boolean,
  newNoNL: boolean,
  header: string
): string {
  const lastIdx = originalLines.length - 1;
  const start = Math.max(0, lastIdx - DEFAULT_CONTEXT);
  const body: string[] = [];
  for (let i = start; i < lastIdx; i++) {
    body.push(" " + originalLines[i]);
  }
  const lastLine = originalLines[lastIdx] ?? "";
  body.push("-" + lastLine);
  if (oldNoNL) body.push("\\ No newline at end of file");
  body.push("+" + lastLine);
  if (newNoNL) body.push("\\ No newline at end of file");

  const count = originalLines.length - start;
  const oldRange = formatRange(start, count);
  const newRange = formatRange(start, count);
  return header + `@@ -${oldRange} +${newRange} @@\n${body.join("\n")}\n`;
}

/**
 * 2つのテキストを行単位で比較し、LCS ベースで diff 行列を返す。
 * (context / remove / add の並び)
 */
export function diffLines(original: string, proposed: string): DiffLine[] {
  const a = splitLines(original);
  const b = splitLines(proposed);
  const n = a.length;
  const m = b.length;

  if (Math.max(n, m) > MAX_LCS_LINES || n * m > MAX_LCS_CELLS) {
    return fullReplacementDiff(a, b);
  }

  // dp[i][j] = a[0..i-1] と b[0..j-1] の LCS 長
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ type: "context", text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      out.push({ type: "remove", text: a[i - 1] });
      i--;
    } else {
      out.push({ type: "add", text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ type: "remove", text: a[--i] });
  }
  while (j > 0) {
    out.push({ type: "add", text: b[--j] });
  }
  out.reverse();
  return out;
}

/** hunk ヘッダの範囲表記 (count=1 は番号のみ、count=0 は前行番号) を組む。 */
function formatRange(startBefore: number, count: number): string {
  if (count === 0) return `${startBefore},0`;
  const begin = startBefore + 1;
  if (count === 1) return `${begin}`;
  return `${begin},${count}`;
}

const DEFAULT_CONTEXT = 3;

/**
 * unified diff 文字列を生成する。差分が無い場合は空文字列を返す。
 * 末尾改行の有無を検出して `\ No newline at end of file` マーカーを出力する。
 * CRLF は LF に正規化して扱う(壊さない)。
 * @param relFile ヘッダに載せる相対パス (省略時は generic ラベル)
 */
export function createUnifiedDiff(
  original: string,
  proposed: string,
  relFile?: string
): string {
  const dlines = diffLines(original, proposed);
  const hasChange = dlines.some((l) => l.type !== "context");

  const oldNoNL = !hasTrailingNewline(original);
  const newNoNL = !hasTrailingNewline(proposed);

  const label = relFile ?? "";
  const header = label
    ? `--- a/${label}\n+++ b/${label}\n`
    : `--- original\n+++ proposed\n`;

  if (!hasChange) {
    if (original !== proposed && oldNoNL !== newNoNL) {
      return createTrailingNewlineOnlyDiff(
        splitLines(original),
        oldNoNL,
        newNoNL,
        header
      );
    }
    return "";
  }

  // old側・new側の最終行(それぞれ context|remove / context|add)の dlines インデックス
  let oldLastIdx = -1;
  let newLastIdx = -1;
  for (let k = 0; k < dlines.length; k++) {
    const t = dlines[k].type;
    if (t === "context" || t === "remove") oldLastIdx = k;
    if (t === "context" || t === "add") newLastIdx = k;
  }
  const finalContextNewlineChanged =
    oldNoNL !== newNoNL &&
    oldLastIdx === newLastIdx &&
    oldLastIdx >= 0 &&
    dlines[oldLastIdx].type === "context";

  // 変更行のインデックスを収集
  const changeIdx: number[] = [];
  dlines.forEach((l, idx) => {
    if (l.type !== "context") changeIdx.push(idx);
  });
  if (finalContextNewlineChanged) {
    changeIdx.push(oldLastIdx);
    changeIdx.sort((a, b) => a - b);
  }

  // 隣接 hunk のマージ (間隔 <= 2*context+1 なら同一 hunk)
  const hunks: number[][] = [];
  let cur: number[] = [];
  for (const idx of changeIdx) {
    if (cur.length === 0) {
      cur.push(idx);
    } else if (idx - cur[cur.length - 1] <= 2 * DEFAULT_CONTEXT + 1) {
      cur.push(idx);
    } else {
      hunks.push(cur);
      cur = [idx];
    }
  }
  if (cur.length) hunks.push(cur);

  const blocks: string[] = [];
  for (const h of hunks) {
    const start = Math.max(0, h[0] - DEFAULT_CONTEXT);
    const end = Math.min(dlines.length - 1, h[h.length - 1] + DEFAULT_CONTEXT);

    let oldStartBefore = 0;
    let newStartBefore = 0;
    for (let k = 0; k < start; k++) {
      const t = dlines[k].type;
      if (t === "context" || t === "remove") oldStartBefore++;
      if (t === "context" || t === "add") newStartBefore++;
    }

    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = start; k <= end; k++) {
      const l = dlines[k];
      if (l.type === "context") {
        const oldContextNoNL = k === oldLastIdx && oldNoNL;
        const newContextNoNL = k === newLastIdx && newNoNL;
        if (oldContextNoNL && newContextNoNL) {
          body.push(" " + l.text);
          oldCount++;
          newCount++;
          body.push("\\ No newline at end of file");
        } else if (oldContextNoNL || newContextNoNL) {
          body.push("-" + l.text);
          oldCount++;
          if (oldContextNoNL) {
            body.push("\\ No newline at end of file");
          }
          body.push("+" + l.text);
          newCount++;
          if (newContextNoNL) {
            body.push("\\ No newline at end of file");
          }
        } else {
          body.push(" " + l.text);
          oldCount++;
          newCount++;
        }
      } else if (l.type === "remove") {
        body.push("-" + l.text);
        oldCount++;
        if (k === oldLastIdx && oldNoNL) {
          body.push("\\ No newline at end of file");
        }
      } else {
        body.push("+" + l.text);
        newCount++;
        if (k === newLastIdx && newNoNL) {
          body.push("\\ No newline at end of file");
        }
      }
    }

    const oldRange = formatRange(oldStartBefore, oldCount);
    const newRange = formatRange(newStartBefore, newCount);
    blocks.push(`@@ -${oldRange} +${newRange} @@\n${body.join("\n")}`);
  }

  return header + blocks.join("\n") + "\n";
}
