import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import type { DomDescriptor, ResolveResult } from "./types.ts";
import { complete, hasKey, stripCodeFence } from "./claude.ts";

const pExecFile = promisify(execFile);

function withinRoot(root: string, file: string): boolean {
  const rel = relative(root, file);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** ripgrep でリテラル検索。{file,line,preview}[] を返す。 */
async function rgSearch(
  root: string,
  term: string,
  max = 20
): Promise<{ file: string; line: number; preview: string }[]> {
  if (!term || term.length < 3) return [];
  try {
    const { stdout } = await pExecFile(
      "rg",
      [
        "--fixed-strings",
        "--line-number",
        "--no-heading",
        "--color=never",
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
  } catch {
    return []; // 一致なし or rg 無し
  }
}

/**
 * DOM ディスクリプタ → ソース位置。
 * 層A(source あり) を最優先、無ければ層B(ripgrep + LLM 選定)。
 */
export async function resolveSource(
  root: string,
  d: DomDescriptor
): Promise<ResolveResult> {
  // --- 層A: フレームワークが出した正確な source ---
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

  // --- 層B: 特徴文字列でリポジトリ全文検索 (言語非依存) ---
  const terms: string[] = [];
  if (d.id) terms.push(d.id);
  // 一意性が高そうな文字列ほど先に
  if (d.textSnippet && d.textSnippet.length >= 4) terms.push(d.textSnippet);
  for (const c of d.classes) {
    // ユーティリティ系の汎用クラスは弱いが候補にはなる
    if (c.length >= 4) terms.push(c);
  }

  const seen = new Set<string>();
  let candidates: { file: string; line: number; preview: string }[] = [];
  for (const term of terms) {
    const hits = await rgSearch(root, term);
    for (const h of hits) {
      const key = h.file + ":" + h.line;
      if (seen.has(key)) continue;
      if (!withinRoot(root, h.file)) continue;
      seen.add(key);
      candidates.push(h);
    }
    if (candidates.length >= 30) break;
  }

  if (candidates.length === 0) {
    return { file: "", confidence: "low", candidates: [] };
  }
  if (candidates.length === 1) {
    return {
      file: candidates[0].file,
      line: candidates[0].line,
      confidence: "medium",
      candidates,
    };
  }

  // 複数候補 → LLM で最尤を選定 (キーがあれば)
  if (hasKey()) {
    const picked = await pickWithLLM(root, d, candidates);
    if (picked) return picked;
  }

  // フォールバック: textSnippet 一致を優先した先頭
  return {
    file: candidates[0].file,
    line: candidates[0].line,
    confidence: "low",
    candidates: candidates.slice(0, 10),
  };
}

async function pickWithLLM(
  root: string,
  d: DomDescriptor,
  candidates: { file: string; line: number; preview: string }[]
): Promise<ResolveResult | null> {
  const list = candidates
    .slice(0, 15)
    .map(
      (c, i) =>
        `${i}: ${relative(root, c.file)}:${c.line}\n   ${c.preview}`
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
${list}

回答は候補番号の整数のみ(例: 3)。該当が無ければ -1。`;

  try {
    const ans = stripCodeFence(
      await complete(prompt, { model: "claude-haiku-4-5", maxTokens: 16 })
    );
    const idx = parseInt(ans.match(/-?\d+/)?.[0] || "", 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < candidates.length) {
      return {
        file: candidates[idx].file,
        line: candidates[idx].line,
        confidence: "medium",
        candidates: candidates.slice(0, 10),
      };
    }
  } catch {
    // LLM 失敗時はフォールバックへ
  }
  return null;
}
