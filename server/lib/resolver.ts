import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import type { DomDescriptor, ResolveResult } from "./types.ts";
import { complete, hasKey, stripCodeFence } from "./claude.ts";

const pExecFile = promisify(execFile);

// rg バイナリが spawn 可能かを一度だけ判定 (シェル関数や未導入環境では false → Node grep)
let rgUsable: boolean | null = null;
async function isRgUsable(): Promise<boolean> {
  if (rgUsable !== null) return rgUsable;
  try {
    await pExecFile("rg", ["--version"], { maxBuffer: 1 << 16 });
    rgUsable = true;
  } catch {
    rgUsable = false;
  }
  return rgUsable;
}

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".omc",
  ".next",
  ".svelte-kit",
  ".nuxt",
  "vendor",
  "coverage",
  ".cache",
]);
// テキストとして検索する拡張子 (バイナリ回避)
const TEXT_EXT =
  /\.(tsx?|jsx?|mjs|cjs|vue|svelte|astro|html?|css|scss|sass|less|md|mdx|json|ya?ml|php|rb|erb|py|go|java|kt|rs|c|h|cpp|cs|swift|ex|exs|txt|hbs|ejs|pug|twig|blade\.php)$/i;

/** rg 非依存の Node 実装 grep (固定文字列, 行マッチ)。rg が無い環境のフォールバック。 */
async function nodeGrep(
  root: string,
  term: string,
  max = Infinity
): Promise<{ file: string; line: number; preview: string }[]> {
  if (!term || term.length < 3) return [];
  const out: { file: string; line: number; preview: string }[] = [];
  let filesScanned = 0;
  const FILE_CAP = 6000; // 暴走防止

  async function walk(dir: string): Promise<void> {
    if (out.length >= max || filesScanned >= FILE_CAP) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max || filesScanned >= FILE_CAP) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORE_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
        await walk(full);
      } else if (ent.isFile()) {
        if (!TEXT_EXT.test(ent.name)) continue;
        filesScanned++;
        let content: string;
        try {
          const s = await stat(full);
          if (s.size > 1.5 * 1024 * 1024) continue; // 巨大ファイルskip
          content = await readFile(full, "utf8");
        } catch {
          continue;
        }
        if (!content.includes(term)) continue;
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(term)) {
            out.push({
              file: resolve(full),
              line: i + 1,
              preview: lines[i].trim().slice(0, 200),
            });
            if (out.length >= max) return;
          }
        }
      }
    }
  }

  await walk(root);
  return out;
}

function withinRoot(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// =========================================================================
// 層B 精度向上のための純関数群 (scripts/resolver-selftest.mjs で検証)
// =========================================================================

/**
 * Tailwind 等の汎用ユーティリティクラスを判定する。
 * 汎用クラスは「どのプロジェクトでも頻出するためソース特定のノイズになる」ため
 * スコアを大幅に下げる/候補から外す判断材料に使う。
 */
const GENERIC_CLASS_SET = new Set<string>([
  // レイアウト骨格
  "flex",
  "inline-flex",
  "grid",
  "inline-grid",
  "block",
  "inline-block",
  "inline",
  "hidden",
  "contents",
  "flow-root",
  "container",
  // 位置
  "relative",
  "absolute",
  "fixed",
  "sticky",
  // 変換/遷移/アニメーションの基底
  "transition",
  "transform",
  "animate-none",
  "animate-spin",
  "animate-pulse",
  "animate-bounce",
  // その他出現率が極めて高いもの
  "overflow-hidden",
  "overflow-auto",
  "overflow-scroll",
  "overflow-visible",
  "w-full",
  "h-full",
  "max-w-full",
  "rounded",
  "rounded-full",
  "rounded-none",
  "shadow",
  "shadow-none",
  "font-bold",
  "font-normal",
  "font-medium",
  "font-semibold",
  "font-light",
  "font-thin",
  "font-extrabold",
  "font-black",
  "italic",
  "not-italic",
  "uppercase",
  "lowercase",
  "normal-case",
  "truncate",
  "line-clamp-1",
  "line-clamp-2",
  "line-clamp-3",
  "line-through",
  "no-underline",
  "underline",
]);

// 汎用ユーティリティ (Tailwind 等) のプロパティ名。compound プレフィックスも含む。
const PROPERTY_PREFIXES = new Set<string>([
  "p", "px", "py", "pt", "pr", "pb", "pl",
  "m", "mx", "my", "mt", "mr", "mb", "ml",
  "gap", "space", "w", "h", "size", "min", "max",
  "text", "font", "leading", "tracking",
  "bg", "from", "via", "to", "border", "rounded", "shadow", "outline", "ring",
  "opacity", "z", "top", "left", "right", "bottom", "inset",
  "grid", "col", "row", "flex", "justify", "items", "self", "place", "order",
  "rotate", "scale", "translate", "skew", "duration", "ease", "transition", "transform",
  "overflow", "cursor", "pointer", "select", "divide", "animate", "decoration",
  "align", "list", "placeholder", "accent", "caret", "blur", "grayscale", "invert",
  "saturate", "sepia", "backdrop", "aspect", "filter", "mix", "container", "float",
]);

// 値セグメントとして許容する scale/keyword (色名・サイズ・状態名)
const COLOR_NAMES = new Set<string>([
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal",
  "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "rose", "slate", "gray", "zinc", "neutral", "stone",
  "black", "white", "transparent", "current", "inherit", "warm", "cool",
]);
const SCALE_KEYWORDS = new Set<string>([
  "auto", "full", "none", "screen", "px", "base",
  "sm", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl", "xs",
]);
const LAYOUT_KEYWORDS = new Set<string>([
  "center", "start", "end", "between", "around", "evenly", "stretch",
  "visible", "hidden", "collapse", "nowrap", "wrap", "reverse",
  "columns", "line", "circle", "all", "default", "normal",
  "thin", "extralight", "light", "medium", "semibold", "bold", "extrabold", "black",
  "italic", "deep", "underline", "default", "resize",
]);
const MODIFIER_SEGMENTS = new Set<string>([
  "x", "y", "t", "r", "b", "l",
  "cols", "rows", "row", "col", "reverse", "nowrap", "wrap",
  "grow", "shrink", "auto", "1", "none",
]);

/** クラス名が Tailwind 等の汎用ユーティリティか (低スコア/除外判定に使用) */
export function isGenericClass(cls: string): boolean {
  if (!cls) return false;
  if (GENERIC_CLASS_SET.has(cls)) return true;
  // PascalCase のコンポーネントクラスは汎用ユーティリティではない
  if (/^[A-Z]/.test(cls)) return false;
  // variant (sm:/hover:/md:.../group-hover:) を除去
  let s = cls;
  while (/^[a-z][\w-]*:/.test(s)) {
    s = s.replace(/^[a-z][\w-]*:/, "");
  }
  if (GENERIC_CLASS_SET.has(s)) return true;
  // 負のユーティリティ (-translate-y-1 等) は先頭の - を無視
  if (s.startsWith("-")) s = s.slice(1);
  const segs = s.split("-");
  if (segs.length === 0) return false;
  const prop = segs[0];
  if (!PROPERTY_PREFIXES.has(prop)) return false;
  const rest = segs.slice(1);
  for (const seg of rest) {
    if (!seg) return false;
    if (/^\d+(?:\.\d+)?(?:\/\d+)?$/.test(seg)) continue; // 数値 scale
    if (/^\[[^\]]+\]$/.test(seg)) continue; // 任意値 [..]
    if (COLOR_NAMES.has(seg)) continue;
    if (SCALE_KEYWORDS.has(seg)) continue;
    if (LAYOUT_KEYWORDS.has(seg)) continue;
    if (MODIFIER_SEGMENTS.has(seg)) continue;
    return false; // 汎用 scale/keyword に合致しない = 固有クラス
  }
  return true;
}

/** DOM ディスクリプタから検索タームを構築 (kind = 重み種別) */
export type TermKind =
  | "textFull"
  | "textPartial"
  | "id"
  | "classSpecific"
  | "classGeneric";

export interface ScoredTerm {
  term: string;
  kind: TermKind;
  /** その term がリポジトリ全体で返したヒット数 (rarity 計算用)。未集計なら 0 */
  hits: number;
}

/** テキストを語単位に分割 (長すぎる textSnippet を部分一致させるフォールバック用) */
export function splitWords(text: string): string[] {
  if (!text) return [];
  const words = text
    .replace(/[`"'*#]/g, " ")
    .split(/[\s.,!?;:()/|<>]+/)
    .map((w) => w.trim())
    // 非ASCII (CJK など) は短くても残す。ASCII は 3〜40 文字で残す。
    .filter(
      (w) => (w.length >= 1 && /[^\x00-\x7F]/.test(w)) || (w.length >= 3 && w.length <= 40)
    );
  // 重複排除しつつ順序維持
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

/** descriptor → kind 付き term 一覧 (検索順序を保つ) */
export function buildTerms(d: DomDescriptor): { term: string; kind: TermKind }[] {
  const out: { term: string; kind: TermKind }[] = [];
  if (d.textSnippet && d.textSnippet.trim().length >= 4) {
    out.push({ term: d.textSnippet.trim(), kind: "textFull" });
  }
  if (d.id && d.id.length >= 3) {
    out.push({ term: d.id, kind: "id" });
  }
  for (const c of d.classes) {
    if (!c || c.length < 3) continue;
    out.push({
      term: c,
      kind: isGenericClass(c) ? "classGeneric" : "classSpecific",
    });
  }
  return out;
}

const KIND_WEIGHT: Record<TermKind, number> = {
  textFull: 100,
  id: 80,
  textPartial: 40,
  classSpecific: 30,
  classGeneric: 2,
};

/** matchTerm がどれだけ希少かを加味して重みを乗せる */
export function termWeight(kind: TermKind, hits: number): number {
  let w = KIND_WEIGHT[kind];
  // ヒット数が少ないほど希少 → 強い信号
  let rarity = 1;
  if (hits <= 0) rarity = 1; // 集計前/未使用なので変動なし
  else if (hits <= 1) rarity = 1.5;
  else if (hits <= 3) rarity = 1.25;
  else if (hits <= 10) rarity = 1.0;
  else if (hits <= 30) rarity = 0.7;
  else rarity = 0.4; // 至る所にある → ノイズ
  return w * rarity;
}

/**
 * 候補 1 件のスコアを、マッチした term 群から算出する純関数。
 * 複数 term に同時マッチすると加算されるので、textSnippet + id + 固有クラス
 * すべてにマッチする行が最も高得点。
 */
export function scoreCandidate(
  matched: ScoredTerm[]
): number {
  let s = 0;
  for (const m of matched) {
    s += termWeight(m.kind, m.hits);
  }
  return s;
}

/** 希少 term (高信号) が 1 つでもマッチしているか */
export function hasRareTerm(matched: ScoredTerm[]): boolean {
  return matched.some(
    (m) =>
      (m.kind === "textFull" || m.kind === "id" || m.kind === "textPartial") &&
      m.hits <= 10
  );
}

// =========================================================================
// ripgrep ラッパ
// =========================================================================

/** ripgrep でリテラル検索。{file,line,preview}[] を返す。 */
async function rgSearch(
  root: string,
  term: string,
  max = 20
): Promise<{ file: string; line: number; preview: string }[]> {
  if (!term || term.length < 3) return [];
  if (!(await isRgUsable())) return nodeGrep(root, term, max);
  const parse = (stdout: string) => {
    const out: { file: string; line: number; preview: string }[] = [];
    for (const line of stdout.split("\n")) {
      const m = line.match(/^(.*?):(\d+):(.*)$/);
      if (!m) continue;
      out.push({
        file: resolve(m[1]),
        line: Number(m[2]),
        preview: m[3].trim().slice(0, 200),
      });
      if (out.length >= max) break;
    }
    return out;
  };
  try {
    const { stdout } = await pExecFile(
      "rg",
      [
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--color=never",
        "--no-messages",
        "--max-count=5",
        "-g",
        "!**/node_modules/**",
        "-g",
        "!**/dist/**",
        "-g",
        "!**/.git/**",
        "-g",
        "!**/build/**",
        term,
        root,
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    return parse(stdout);
  } catch (e: any) {
    // rg は exit 1=一致なし、exit 2=一部読めないファイルがあった場合でも
    // stdout には有効なマッチが入る。stdout があれば解析する。
    if (e && typeof e.stdout === "string" && e.stdout) return parse(e.stdout);
    return []; // 一致なし or rg 無し
  }
}

/**
 * リポジトリ全体での term の総マッチ件数を数える (rarity 計算用)。
 * rgSearch は候補位置取得のため上限20で打ち切るので、希少性判定には
 * 上限なしのカウント専用クエリ(--count-matches)を使う。
 */
async function rgCount(root: string, term: string): Promise<number> {
  if (!term || term.length < 3) return 0;
  if (!(await isRgUsable())) return (await nodeGrep(root, term)).length;
  const parse = (stdout: string) => {
    let total = 0;
    for (const line of stdout.split("\n")) {
      const n = parseInt(line, 10);
      if (!Number.isNaN(n)) total += n;
    }
    return total;
  };
  try {
    const { stdout } = await pExecFile(
      "rg",
      [
        "--fixed-strings",
        "--count-matches",
        "--no-filename",
        "--color=never",
        "--no-messages",
        "-g",
        "!**/node_modules/**",
        "-g",
        "!**/dist/**",
        "-g",
        "!**/.git/**",
        "-g",
        "!**/build/**",
        term,
        root,
      ],
      { maxBuffer: 4 * 1024 * 1024 }
    );
    return parse(stdout);
  } catch (e: any) {
    // exit 2 (一部読めず) でも stdout のカウントは有効
    if (e && typeof e.stdout === "string" && e.stdout) return parse(e.stdout);
    return 0; // 一致なし(rg exit 1) or rg 無し
  }
}

// =========================================================================
// 候補収集 + スコアリング
// =========================================================================

interface CandidateAgg {
  file: string;
  line: number;
  preview: string;
  matched: ScoredTerm[];
  score: number;
}

/** textSnippet 単語分割フォールバックを含む候補収集 */
async function collectCandidates(
  root: string,
  d: DomDescriptor
): Promise<{ candidates: CandidateAgg[]; termHits: Map<string, number> }> {
  const terms = buildTerms(d);
  // term → 総ヒット件数 (rarity 計算用に第1パスで集計するため、最初は hits=0 で埋める)
  const termHits = new Map<string, number>();

  // 第1パス: textSnippet(全文) / id / 各クラス で検索
  const byKey = new Map<string, CandidateAgg>();
  for (const { term, kind } of terms) {
    const hits = await rgSearch(root, term);
    // rarity は上限なしの真の件数で判定 (rgSearch は位置取得用に20で打ち切るため)
    termHits.set(term, await rgCount(root, term));
    if (hits.length === 0) continue;
    for (const h of hits) {
      if (!withinRoot(root, h.file)) continue;
      const key = h.file + ":" + h.line;
      let c = byKey.get(key);
      if (!c) {
        c = { file: h.file, line: h.line, preview: h.preview, matched: [], score: 0 };
        byKey.set(key, c);
      }
      // 同一 term が同一行に複数回マッチしても1回扱い
      if (!c.matched.some((m) => m.term === term && m.kind === kind)) {
        c.matched.push({ term, kind, hits: hits.length });
      }
    }
  }

  // 第2パス: textSnippet 全文で 0 ヒット → 語分割で部分一致フォールバック
  const didFullTextHit =
    d.textSnippet && d.textSnippet.trim().length >= 4
      ? (termHits.get(d.textSnippet.trim()) ?? 0) > 0
      : true;
  if (!didFullTextHit && d.textSnippet) {
    const words = splitWords(d.textSnippet);
    for (const w of words) {
      const count = await rgCount(root, w);
      // 1 word で 100 件も引っかかるようならノイズなので無視 (真の件数で判定)
      if (count === 0 || count > 100) continue;
      const hits = await rgSearch(root, w);
      if (hits.length === 0) continue;
      termHits.set("__partial__" + w, count);
      for (const h of hits) {
        if (!withinRoot(root, h.file)) continue;
        const key = h.file + ":" + h.line;
        let c = byKey.get(key);
        if (!c) {
          c = { file: h.file, line: h.line, preview: h.preview, matched: [], score: 0 };
          byKey.set(key, c);
        }
        if (!c.matched.some((m) => m.term === w && m.kind === "textPartial")) {
          c.matched.push({ term: w, kind: "textPartial", hits: hits.length });
        }
      }
    }
  }

  // rarity 集計済 → 各候補の matched.hits を更新しつつスコア計算
  const candidates: CandidateAgg[] = [];
  for (const c of byKey.values()) {
    const scored: ScoredTerm[] = c.matched.map((m) => ({
      term: m.term,
      kind: m.kind,
      hits: termHits.get(
        m.kind === "textPartial" ? "__partial__" + m.term : m.term
      ) ?? m.hits,
    }));
    c.matched = scored;
    c.score = scoreCandidate(scored);
    candidates.push(c);
  }
  // score 降順、同点なら行番号昇順で安定
  candidates.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.line - b.line
  );

  return { candidates, termHits };
}

// =========================================================================
// 公開 API (シグネチャ維持)
// =========================================================================

/**
 * DOM ディスクリプタ → ソース位置。
 * 層A(source あり) を最優先、無ければ層B(ripgrep + スコアリング + LLM 選定)。
 */
export async function resolveSource(
  root: string,
  d: DomDescriptor
): Promise<ResolveResult> {
  // --- 層A: フレームワークが出した正確な source (回帰なし: 即 high) ---
  if (d.source?.fileName) {
    const f = resolve(d.source.fileName);
    if (existsSync(f) && withinRoot(root, f)) {
      return {
        file: f,
        line: d.source.lineNumber,
        col: d.source.columnNumber,
        confidence: "high",
      };
    }
  }

  // --- 層B: 汎用クラス除外スコアリング + フォールバック ---
  const { candidates } = await collectCandidates(root, d);

  if (candidates.length === 0) {
    return { file: "", confidence: "low", candidates: [] };
  }

  const best = candidates[0];
  const bestRare = hasRareTerm(best.matched);
  const single = candidates.length === 1;

  // confidence 判定
  // - 候補1件 かつ 希少 term(id / textSnippet) あり → high 寄り (high に寄せる)
  // - 候補1件 だが クラス等の弱信号のみ → medium
  // - 複数候補 だが best が希少 term で明確にリード → medium
  // - それ以外 → low
  let confidence: ResolveResult["confidence"];
  if (single && bestRare) confidence = "high";
  else if (single) confidence = "medium";
  else if (bestRare && best.score > 0) confidence = "medium";
  else confidence = "low";

  // 候補のプレビュー配列 (上位10件)
  const previewList = candidates.slice(0, 10).map((c) => ({
    file: c.file,
    line: c.line,
    preview: c.preview,
  }));

  // 複数候補で有力なリードが不明瞭 → LLM で最尤を選定 (キーがあれば)
  const hasClearLead =
    candidates.length === 1 || (candidates.length >= 2 &&
      best.score - (candidates[1]?.score ?? 0) >= 30);
  if (!hasClearLead && hasKey()) {
    const picked = await pickWithLLM(root, d, candidates, previewList);
    if (picked) return picked;
  }

  return {
    file: best.file,
    line: best.line,
    confidence,
    candidates: previewList,
  };
}

async function pickWithLLM(
  root: string,
  d: DomDescriptor,
  candidates: CandidateAgg[],
  previewList: { file: string; line: number; preview: string }[]
): Promise<ResolveResult | null> {
  const list = candidates
    .slice(0, 15)
    .map(
      (c, i) =>
        `${i}: ${relative(root, c.file)}:${c.line} (score=${Math.round(c.score)})\n   ${c.preview}`
    )
    .join("\n");
  const prompt = `あなたはコード位置特定の専門家です。
ユーザーがレンダリングされた画面で次の要素をクリックしました:
- tag: ${d.tag}
- id: ${d.id || "(なし)"}
- classes: ${d.classes.join(" ") || "(なし)"}
- text: ${d.textSnippet || "(なし)"}
- domPath: ${d.domPath}

この要素を生成しているソース行として最も確からしい候補を、次から1つ選んでください。
スコアは textSnippet/id の一致を重視し、汎用ユーティリティクラス(flex, px-4 等)は無視してください。
${list}

回答は候補番号の整数のみ(例: 3)。該当が無ければ -1。`;

  try {
    const ans = stripCodeFence(
      await complete(prompt, { model: "claude-haiku-4-5", maxTokens: 16 })
    );
    const idx = parseInt(ans.match(/-?\d+/)?.[0] || "", 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
      const c = candidates[idx];
      return {
        file: c.file,
        line: c.line,
        confidence: "medium",
        candidates: previewList,
      };
    }
  } catch {
    // LLM 失敗時はフォールバックへ
  }
  return null;
}