import { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, relative, isAbsolute, basename } from "node:path";
import { env } from "../lib/env.ts";
import { hasKey, complete, stripCodeFence } from "../lib/claude.ts";
import { resolveSource } from "../lib/resolver.ts";
import { createUnifiedDiff } from "../lib/diff.ts";
import {
  getInfo,
  getRoot,
  getLogs,
  openProject,
  startProject,
  stopProject,
} from "../lib/state.ts";
import type { DomDescriptor } from "../lib/types.ts";

const pExecFile = promisify(execFile);
export const api = new Hono();

// --- diff提案フロー の メモリストア (プロセス内) ---
type Confidence = "high" | "medium" | "low";

interface ProposalEntry {
  file: string;
  original: string;
  proposed: string;
  relFile: string;
  line?: number;
  confidence: Confidence;
}

interface UndoEntry {
  file: string;
  relFile: string;
  /** 適用直前のディスク内容 */
  previousContent: string;
  proposalId: string;
}

const proposalStore = new Map<string, ProposalEntry>();
const undoStack: UndoEntry[] = [];
// テスト/検証用途にストアを公開 (本番はプロセス内メモリ)
export const __stores = { proposalStore, undoStack };

function inRoot(root: string, file: string): boolean {
  const rel = relative(root, resolve(file));
  return !rel.startsWith("..") && !isAbsolute(rel);
}

api.get("/status", (c) =>
  c.json({ info: getInfo(), hasKey: hasKey(), logs: getLogs().slice(-50) })
);

api.post("/project/open", async (c) => {
  const { path, runCommand } = await c.req.json<{
    path: string;
    runCommand?: string;
  }>();
  if (!path || !existsSync(path))
    return c.json({ error: `パスが存在しません: ${path}` }, 400);
  try {
    await openProject(resolve(path), { command: runCommand });
    const info = await startProject();
    return c.json({ info });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

api.post("/project/clone", async (c) => {
  const { repo, runCommand } = await c.req.json<{
    repo: string;
    runCommand?: string;
  }>();
  if (!repo) return c.json({ error: "repo URL が必要です" }, 400);
  try {
    const wsDir = resolve(env.workspacesDir);
    await mkdir(wsDir, { recursive: true });
    const name = basename(repo).replace(/\.git$/, "") || "repo";
    const dest = join(wsDir, name);
    if (!existsSync(dest)) {
      await pExecFile("git", ["clone", "--depth", "1", repo, dest], {
        maxBuffer: 8 * 1024 * 1024,
      });
    }
    // 依存があれば install (node プロジェクト)
    if (existsSync(join(dest, "package.json")) && !existsSync(join(dest, "node_modules"))) {
      await pExecFile("npm", ["install"], { cwd: dest, maxBuffer: 32 * 1024 * 1024 }).catch(
        () => {}
      );
    }
    await openProject(dest, { command: runCommand });
    const info = await startProject();
    return c.json({ info });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

api.post("/project/start", async (c) => {
  try {
    return c.json({ info: await startProject() });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

api.post("/project/stop", async (c) => {
  await stopProject();
  return c.json({ info: getInfo() });
});

api.get("/files/read", async (c) => {
  const root = getRoot();
  const path = c.req.query("path") || "";
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  if (!inRoot(root, path)) return c.json({ error: "範囲外のパス" }, 403);
  try {
    const content = await readFile(resolve(path), "utf8");
    return c.json({ path: resolve(path), content });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

api.post("/files/write", async (c) => {
  const root = getRoot();
  const { path, content } = await c.req.json<{ path: string; content: string }>();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  if (!inRoot(root, path)) return c.json({ error: "範囲外のパス" }, 403);
  try {
    await writeFile(resolve(path), content, "utf8");
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

api.post("/edit", async (c) => {
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  if (!hasKey())
    return c.json(
      { error: "ANTHROPIC_API_KEY 未設定。.env に設定してください。" },
      400
    );

  const { descriptor, instruction } = await c.req.json<{
    descriptor: DomDescriptor;
    instruction: string;
  }>();
  if (!instruction?.trim())
    return c.json({ error: "指示が空です" }, 400);

  try {
    // 1. ソース解決 (層A/B)
    const resolved = await resolveSource(root, descriptor);
    if (!resolved.file) {
      return c.json({
        ok: false,
        error:
          "対象のソース箇所を特定できませんでした。要素のテキストやclass/idが手がかりに乏しい可能性があります。",
        confidence: "low",
        candidates: resolved.candidates,
      });
    }
    if (!inRoot(root, resolved.file))
      return c.json({ error: "解決先がプロジェクト範囲外" }, 403);

    // 2. 提案生成 (ファイルはまだ書かない)
    const result = await buildProposalForFile(
      root,
      resolved.file,
      resolved.line,
      descriptor,
      instruction,
      resolved.confidence
    );

    // 3. 低確度/複数候補時は candidates を同梱
    const includeCandidates =
      resolved.confidence === "low" ||
      (Array.isArray(resolved.candidates) && resolved.candidates.length > 1);
    return c.json(
      includeCandidates
        ? { ...result, candidates: resolved.candidates }
        : result
    );
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

/**
 * 指定ファイルに対する編集提案を生成し、メモリストアに保存して
 * 提案レスポンス({ok, proposalId, file, relFile, line, confidence, diff})を返す。
 * ファイルへの書き込みは行わない。
 */
async function buildProposalForFile(
  root: string,
  file: string,
  line: number | undefined,
  descriptor: DomDescriptor,
  instruction: string,
  confidence: Confidence
): Promise<
  | {
      ok: true;
      proposalId: string;
      file: string;
      relFile: string;
      line?: number;
      confidence: Confidence;
      diff: string;
      summary: string;
    }
  | {
      ok: false;
      file: string;
      relFile: string;
      line?: number;
      confidence: Confidence;
      summary: string;
    }
> {
  const relFile = relative(root, file);
  const original = await readFile(file, "utf8");
  const prompt = buildEditPrompt(relFile, original, descriptor, line, instruction);
  const raw = await complete(prompt, { maxTokens: 16000 });
  const edited = stripCodeFence(raw);

  if (!edited || edited.trim() === original.trim()) {
    return {
      ok: false,
      file,
      relFile,
      line,
      confidence,
      summary: "変更が生成されませんでした。指示をより具体的にしてください。",
    };
  }

  const diff = createUnifiedDiff(original, edited, relFile);
  const proposalId = randomUUID();
  proposalStore.set(proposalId, {
    file,
    original,
    proposed: edited,
    relFile,
    line,
    confidence,
  });

  return {
    ok: true,
    proposalId,
    file,
    relFile,
    line,
    confidence,
    diff,
    summary: `${relFile} の提案を生成しました。`,
  };
}

/** 候補選択時: 指定ファイルで提案を作る。 */
api.post("/edit/candidate", async (c) => {
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);

  const { file, line, descriptor, instruction } = await c.req.json<{
    file: string;
    line?: number;
    descriptor?: DomDescriptor;
    instruction: string;
  }>();
  if (!file) return c.json({ error: "file が必要です" }, 400);
  if (!instruction?.trim())
    return c.json({ error: "指示が空です" }, 400);
  if (!inRoot(root, file))
    return c.json({ error: "範囲外のパス" }, 403);

  const abs = resolve(file);
  if (!existsSync(abs))
    return c.json({ error: `ファイルが存在しません: ${file}` }, 404);

  if (!hasKey())
    return c.json(
      { error: "ANTHROPIC_API_KEY 未設定。.env に設定してください。" },
      400
    );

  const desc: DomDescriptor = descriptor ?? {
    tag: "",
    classes: [],
    attrs: {},
    domPath: "",
  };

  try {
    const result = await buildProposalForFile(
      root,
      abs,
      line,
      desc,
      instruction,
      "medium"
    );
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

/** 提案を適用: ここで初めてファイルを書き、直前内容を undo スタックへ。 */
api.post("/edit/apply", async (c) => {
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  const { proposalId } = await c.req.json<{ proposalId: string }>();
  if (!proposalId)
    return c.json({ error: "proposalId が必要です" }, 400);

  const p = proposalStore.get(proposalId);
  if (!p)
    return c.json(
      { error: "提案が見つかりません (期限切れまたは未存在)。" },
      404
    );
  if (!inRoot(root, p.file))
    return c.json({ error: "解決先がプロジェクト範囲外" }, 403);

  try {
    const before = await readFile(p.file, "utf8");
    await writeFile(p.file, p.proposed, "utf8");
    undoStack.push({
      file: p.file,
      relFile: p.relFile,
      previousContent: before,
      proposalId,
    });
    proposalStore.delete(proposalId);
    return c.json({
      ok: true,
      file: p.file,
      relFile: p.relFile,
      line: p.line,
      summary: `${p.relFile} を適用しました。`,
    });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

/** 提案を破棄。 */
api.post("/edit/reject", async (c) => {
  const { proposalId } = await c.req.json<{ proposalId: string }>();
  if (!proposalId)
    return c.json({ error: "proposalId が必要です" }, 400);
  if (!proposalStore.delete(proposalId))
    return c.json({ error: "提案が見つかりません。" }, 404);
  return c.json({ ok: true });
});

/** 最後の適用を取り消す。 */
api.post("/edit/undo", async (c) => {
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  const entry = undoStack.pop();
  if (!entry)
    return c.json({ error: "元に戻せる適用がありません。" }, 404);
  if (!inRoot(root, entry.file)) {
    undoStack.push(entry);
    return c.json({ error: "対象がプロジェクト範囲外" }, 403);
  }
  try {
    await writeFile(entry.file, entry.previousContent, "utf8");
    return c.json({
      ok: true,
      file: entry.file,
      relFile: entry.relFile,
      summary: `${entry.relFile} の適用を取り消しました。`,
    });
  } catch (e: any) {
    undoStack.push(entry);
    return c.json({ error: String(e.message || e) }, 500);
  }
});

function buildEditPrompt(
  relFile: string,
  content: string,
  d: DomDescriptor,
  line: number | undefined,
  instruction: string
): string {
  return `あなたは熟練のフロントエンド開発者です。ユーザーが画面上の要素を選び、自然言語で変更を指示しました。
対象ファイルを編集し、**ファイル全体を1つのコードブロックで** 返してください。説明文は不要です。

# 対象ファイル: ${relFile}
${line ? `# 対象付近の行: ${line}` : ""}
# 選択された要素
- tag: ${d.tag}
- id: ${d.id || "(なし)"}
- classes: ${d.classes.join(" ") || "(なし)"}
- text: ${d.textSnippet || "(なし)"}

# ユーザーの指示
${instruction}

# 制約
- 指示に関係する最小限の変更に留め、それ以外の挙動・整形を変えない。
- 既存のコードスタイル/インデント/フレームワーク作法に合わせる。
- ファイル全体を完全な形で返す(省略やプレースホルダ禁止)。

# 現在のファイル内容
\`\`\`
${content}
\`\`\``;
}

// --- git (MVP minimal) ---
api.get("/git/status", async (c) => {
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  try {
    const { stdout } = await pExecFile("git", ["status", "--porcelain"], {
      cwd: root,
    });
    return c.json({ changes: stdout.split("\n").filter(Boolean) });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

api.post("/git/commit", async (c) => {
  const root = getRoot();
  const { message } = await c.req.json<{ message: string }>();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  try {
    await pExecFile("git", ["add", "-A"], { cwd: root });
    await pExecFile("git", ["commit", "-m", message || "UImaneger edit"], {
      cwd: root,
    });
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});
