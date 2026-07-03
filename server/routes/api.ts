import { Hono } from "hono";
import type { Context } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { resolve, join, relative, isAbsolute, basename, dirname } from "node:path";
import { env } from "../lib/env.ts";
import { hasKey, complete, stripCodeFence, TruncatedError } from "../lib/claude.ts";
import { resolveSource } from "../lib/resolver.ts";
import { createUnifiedDiff } from "../lib/diff.ts";
import {
  getInfo,
  getRoot,
  getLogs,
  getBefore,
  openAndStart,
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
  originalBytes: Buffer;
  original: string;
  proposed: string;
  relFile: string;
  line?: number;
  confidence: Confidence;
  createdAt: number;
  hadBom: boolean;
}

interface UndoEntry {
  file: string;
  relFile: string;
  /** 適用直前のディスク内容 */
  previousContent: string;
  /** 適用後にディスク上へ書いた内容 */
  appliedContent: string;
  proposalId: string;
}

const PROPOSAL_TTL_MS = 30 * 60 * 1000;
const PROPOSAL_MAX = 100;
const UNDO_MAX = 50;

const proposalStore = new Map<string, ProposalEntry>();
const undoStack: UndoEntry[] = [];
// テスト/検証用途にストアを公開 (本番はプロセス内メモリ)
export const __stores = { proposalStore, undoStack };

/** apply/undo 中の proposalId を保護するための処理中セット(同一 proposalId の並行二重書き込み防止)。 */
const inFlight = new Set<string>();
let storesRoot: string | null = null;

function sanitizeForLog(value: unknown): string {
  let s = String(value ?? "");
  for (const secret of [env.anthropicKey, process.env.ANTHROPIC_API_KEY]) {
    if (secret) s = s.split(secret).join("[REDACTED]");
  }
  return s.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

function serverError(c: Context, e: unknown, relFile?: string) {
  const err = e as { name?: string; message?: string; status?: unknown };
  console.error(
    JSON.stringify({
      level: "error",
      method: c.req.method,
      route: c.req.path,
      relFile,
      name: sanitizeForLog(err?.name || "Error"),
      message: sanitizeForLog(err?.message ?? e),
      status: err?.status,
    })
  );
  return c.json({ error: sanitizeForLog((e as Error)?.message ?? e) }, 500);
}

function ensureStoresForCurrentRoot(): void {
  const root = getRoot();
  if (root === storesRoot) return;
  proposalStore.clear();
  undoStack.splice(0);
  inFlight.clear();
  storesRoot = root;
}

function isWithinPath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function remapBeforeSource(root: string, d: DomDescriptor): DomDescriptor {
  const source = d.source;
  const fileName = source?.fileName;
  if (!fileName || !isAbsolute(fileName)) return d;
  const before = getBefore();
  if (!before?.dir || !isWithinPath(before.dir, fileName)) return d;
  return {
    ...d,
    source: {
      fileName: join(root, relative(resolve(before.dir), resolve(fileName))),
      lineNumber: source.lineNumber,
      columnNumber: source.columnNumber,
    },
  };
}

function decodeEditableUtf8(buf: Buffer):
  | { ok: true; text: string; hadBom: boolean }
  | { ok: false; error: string } {
  const decoded = buf.toString("utf8");
  if (Buffer.compare(Buffer.from(decoded, "utf8"), buf) !== 0) {
    return {
      ok: false,
      error: "このファイルはUTF-8ではないため安全に編集できません。",
    };
  }
  const hadBom = decoded.startsWith("\uFEFF");
  return {
    ok: true,
    text: hadBom ? decoded.slice(1) : decoded,
    hadBom,
  };
}

function withBom(content: string, hadBom: boolean): string {
  const withoutBom = content.startsWith("\uFEFF") ? content.slice(1) : content;
  return hadBom ? `\uFEFF${withoutBom}` : withoutBom;
}

/** 期限切れ・過剰件数の提案を破棄(TTL 30分 / 上限 PROPOSAL_MAX)。 */
function pruneProposals(): void {
  const now = Date.now();
  for (const [id, entry] of proposalStore) {
    if (now - entry.createdAt > PROPOSAL_TTL_MS) proposalStore.delete(id);
  }
  if (proposalStore.size > PROPOSAL_MAX) {
    const sorted = [...proposalStore.entries()].sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    );
    const removeCount = proposalStore.size - PROPOSAL_MAX;
    for (let k = 0; k < removeCount; k++) proposalStore.delete(sorted[k][0]);
  }
}

/** undo スタックへ積みつつ件数上限(UNDO_MAX)を維持。古いものから破棄。 */
function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry);
  while (undoStack.length > UNDO_MAX) undoStack.shift();
}

/**
 * root 配下かを realpath で判定(シンボリックリンク経由のトラバーサルを防止)。
 * ファイルが未存在の場合は親ディレクトリを realpath して判定する。
 */
function inRoot(root: string, file: string): boolean {
  if (typeof root !== "string" || typeof file !== "string") return false;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const abs = resolve(file);
  let realFile: string;
  try {
    realFile = realpathSync(abs);
  } catch {
    try {
      const realParent = realpathSync(dirname(abs));
      realFile = join(realParent, basename(abs));
    } catch {
      return false;
    }
  }
  const rel = relative(realRoot, realFile);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * descriptor の形を検証。必須フィールドを欠落や型違いで 400 にするためのエラー文を返す。
 * classes は任意扱い(未指定可)。
 */
function validateDescriptor(d: unknown): string | null {
  if (!d || typeof d !== "object") return "descriptor が必要です。";
  const o = d as Record<string, unknown>;
  if (typeof o.tag !== "string") return "descriptor.tag は文字列である必要があります。";
  if (o.id !== undefined && typeof o.id !== "string")
    return "descriptor.id は文字列である必要があります。";
  if (o.classes !== undefined && !Array.isArray(o.classes))
    return "descriptor.classes は配列である必要があります。";
  if (
    Array.isArray(o.classes) &&
    !o.classes.every((c) => typeof c === "string")
  )
    return "descriptor.classes は文字列配列である必要があります。";
  if (
    o.attrs !== undefined &&
    (typeof o.attrs !== "object" || o.attrs === null || Array.isArray(o.attrs))
  )
    return "descriptor.attrs はオブジェクトである必要があります。";
  if (o.textSnippet !== undefined && typeof o.textSnippet !== "string")
    return "descriptor.textSnippet は文字列である必要があります。";
  if (o.domPath !== undefined && typeof o.domPath !== "string")
    return "descriptor.domPath は文字列である必要があります。";
  if (o.source !== undefined) {
    if (
      typeof o.source !== "object" ||
      o.source === null ||
      Array.isArray(o.source)
    )
      return "descriptor.source はオブジェクトである必要があります。";
    const s = o.source as Record<string, unknown>;
    if (s.fileName !== undefined && typeof s.fileName !== "string")
      return "descriptor.source.fileName は文字列である必要があります。";
    if (s.lineNumber !== undefined && typeof s.lineNumber !== "number")
      return "descriptor.source.lineNumber は数値である必要があります。";
    if (s.columnNumber !== undefined && typeof s.columnNumber !== "number")
      return "descriptor.source.columnNumber は数値である必要があります。";
  }
  return null;
}

/** 検証済み descriptor の任意フィールド(classes/attrs/domPath)を安全な既定値で補充する。 */
function normalizeDescriptor(d: DomDescriptor): DomDescriptor {
  return {
    ...d,
    classes: Array.isArray(d.classes) ? d.classes : [],
    attrs:
      d.attrs && typeof d.attrs === "object" && !Array.isArray(d.attrs)
        ? d.attrs
        : {},
    domPath: typeof d.domPath === "string" ? d.domPath : "",
    tag: typeof d.tag === "string" ? d.tag : "",
  };
}

api.get("/status", (c) => {
  ensureStoresForCurrentRoot();
  return c.json({
    info: getInfo(),
    hasKey: hasKey(),
    logs: getLogs().slice(-50),
    undoDepth: undoStack.length,
  });
});

api.post("/project/open", async (c) => {
  const { path, runCommand } = await c.req.json<{
    path: string;
    runCommand?: string;
  }>();
  if (!path || !existsSync(path))
    return c.json({ error: `パスが存在しません: ${path}` }, 400);
  try {
    const info = await openAndStart(resolve(path), { command: runCommand });
    return c.json({ info });
  } catch (e) {
    return serverError(c, e);
  }
});

api.post("/project/clone", async (c) => {
  const { repo, runCommand } = await c.req.json<{
    repo: string;
    runCommand?: string;
  }>();
  if (!repo) return c.json({ error: "repo URL が必要です" }, 400);
  let installError: string | null = null;
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
      await pExecFile("npm", ["install", "--ignore-scripts"], {
        cwd: dest,
        maxBuffer: 32 * 1024 * 1024,
      }).catch((e: any) => {
        installError = String(e?.stderr || e?.message || e)
          .split("\n")
          .slice(-8)
          .join("\n");
      });
    }
    const info = await openAndStart(dest, { command: runCommand });
    return c.json({ info });
  } catch (e) {
    if (installError) {
      return c.json(
        {
          error: `依存関係のインストールに失敗した可能性があります:\n${installError}\n---\n起動エラー: ${String(
            (e as Error)?.message ?? e
          )}`,
        },
        500
      );
    }
    return serverError(c, e);
  }
});

api.post("/project/start", async (c) => {
  try {
    return c.json({ info: await startProject() });
  } catch (e) {
    return serverError(c, e);
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
  } catch (e) {
    return serverError(c, e);
  }
});

api.post("/files/write", async (c) => {
  const root = getRoot();
  const { path, content } = await c.req.json<{ path: string; content: string }>();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  if (typeof path !== "string" || typeof content !== "string")
    return c.json({ error: "path と content は文字列である必要があります。" }, 400);
  if (!inRoot(root, path)) return c.json({ error: "範囲外のパス" }, 403);
  try {
    await writeFile(resolve(path), content, "utf8");
    return c.json({ ok: true });
  } catch (e) {
    return serverError(c, e);
  }
});

api.post("/edit", async (c) => {
  ensureStoresForCurrentRoot();
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  if (!hasKey())
    return c.json(
      { error: "ANTHROPIC_API_KEY 未設定。.env に設定してください。" },
      400
    );

  const { descriptor: rawDescriptor, instruction } = await c.req.json<{
    descriptor: DomDescriptor;
    instruction: string;
  }>();
  if (!instruction?.trim())
    return c.json({ error: "指示が空です" }, 400);
  const descErr = validateDescriptor(rawDescriptor);
  if (descErr) return c.json({ error: descErr }, 400);
  const descriptor = remapBeforeSource(root, normalizeDescriptor(rawDescriptor));

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
  } catch (e) {
    return serverError(c, e);
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
      error: string;
    }
> {
  const relFile = relative(root, file);
  const originalBytes = await readFile(file);
  const decoded = decodeEditableUtf8(originalBytes);
  if (!decoded.ok) {
    return {
      ok: false,
      file,
      relFile,
      line,
      confidence,
      error: decoded.error,
    };
  }
  const original = decoded.text;
  const prompt = buildEditPrompt(relFile, original, descriptor, line, instruction);
  let raw: string;
  try {
    raw = await complete(prompt, { maxTokens: 16000 });
  } catch (e) {
    if (e instanceof TruncatedError) {
      return {
        ok: false,
        file,
        relFile,
        line,
        confidence,
        error:
          "ファイルが大きすぎて完全な編集を生成できませんでした。ファイルを分割するか対象箇所を絞ってください。",
      };
    }
    throw e;
  }
  const edited = withBom(stripCodeFence(raw), false);

  if (!edited || edited.trim() === original.trim()) {
    return {
      ok: false,
      file,
      relFile,
      line,
      confidence,
      error: "変更が生成されませんでした。指示をより具体的にしてください。",
    };
  }

  const diff = createUnifiedDiff(original, edited, relFile);
  const proposalId = randomUUID();
  pruneProposals();
  proposalStore.set(proposalId, {
    file,
    originalBytes,
    original,
    proposed: edited,
    relFile,
    line,
    confidence,
    createdAt: Date.now(),
    hadBom: decoded.hadBom,
  });
  pruneProposals();

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
  ensureStoresForCurrentRoot();
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);

  const { file, line, descriptor: rawDescriptor, instruction } = await c.req.json<{
    file: string;
    line?: number;
    descriptor?: DomDescriptor;
    instruction: string;
  }>();
  if (typeof file !== "string" || !file)
    return c.json({ error: "file が必要です" }, 400);
  if (!instruction?.trim())
    return c.json({ error: "指示が空です" }, 400);
  if (rawDescriptor !== undefined) {
    const descErr = validateDescriptor(rawDescriptor);
    if (descErr) return c.json({ error: descErr }, 400);
  }
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

  const desc: DomDescriptor = rawDescriptor
    ? normalizeDescriptor(rawDescriptor)
    : { tag: "", classes: [], attrs: {}, domPath: "" };

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
  } catch (e) {
    return serverError(c, e);
  }
});

/** 提案を適用: ここで初めてファイルを書き、直前内容を undo スタックへ。 */
api.post("/edit/apply", async (c) => {
  ensureStoresForCurrentRoot();
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  const { proposalId } = await c.req.json<{ proposalId: string }>();
  if (!proposalId)
    return c.json({ error: "proposalId が必要です" }, 400);

  pruneProposals();

  const p = proposalStore.get(proposalId);
  if (!p)
    return c.json(
      { error: "提案が見つかりません (期限切れまたは未存在)。" },
      404
    );
  if (!inRoot(root, p.file))
    return c.json({ error: "解決先がプロジェクト範囲外" }, 403);

  // 同一 proposalId の並行 apply を拒否(二重書き込み/undo 二重 push 防止)
  if (inFlight.has(proposalId))
    return c.json({ error: "この提案は現在処理中です。" }, 409);
  inFlight.add(proposalId);

  try {
    const beforeBytes = await readFile(p.file);
    if (Buffer.compare(beforeBytes, p.originalBytes) !== 0) {
      return c.json(
        { error: "ファイルが変更されています。再提案してください。" },
        409
      );
    }
    const before = beforeBytes.toString("utf8");
    const appliedContent = withBom(p.proposed, p.hadBom);
    await writeFile(p.file, appliedContent, "utf8");
    pushUndo({
      file: p.file,
      relFile: p.relFile,
      previousContent: before,
      appliedContent,
      proposalId,
    });
    proposalStore.delete(proposalId);
    return c.json({
      ok: true,
      file: p.file,
      relFile: p.relFile,
      line: p.line,
      summary: `${p.relFile} を適用しました。`,
      undoDepth: undoStack.length,
    });
  } catch (e) {
    return serverError(c, e, p.relFile);
  } finally {
    inFlight.delete(proposalId);
  }
});

/** 提案を破棄。 */
api.post("/edit/reject", async (c) => {
  ensureStoresForCurrentRoot();
  const { proposalId } = await c.req.json<{ proposalId: string }>();
  if (!proposalId)
    return c.json({ error: "proposalId が必要です" }, 400);
  if (inFlight.has(proposalId))
    return c.json({ error: "この提案は現在処理中です。" }, 409);
  pruneProposals();
  if (!proposalStore.delete(proposalId))
    return c.json({ error: "提案が見つかりません。" }, 404);
  return c.json({ ok: true });
});

/** 最後の適用を取り消す。 */
api.post("/edit/undo", async (c) => {
  ensureStoresForCurrentRoot();
  const root = getRoot();
  if (!root) return c.json({ error: "プロジェクト未オープン" }, 400);
  const entry = undoStack.pop();
  if (!entry)
    return c.json({ error: "元に戻せる適用がありません。" }, 404);
  // 同一 proposalId の並行 undo/apply を拒否(二重書き込み防止)
  if (inFlight.has(entry.proposalId)) {
    undoStack.push(entry);
    return c.json({ error: "この提案は現在処理中です。" }, 409);
  }
  inFlight.add(entry.proposalId);
  if (!inRoot(root, entry.file)) {
    undoStack.push(entry);
    inFlight.delete(entry.proposalId);
    return c.json({ error: "対象がプロジェクト範囲外" }, 403);
  }
  try {
    const currentBytes = await readFile(entry.file);
    if (
      Buffer.compare(currentBytes, Buffer.from(entry.appliedContent, "utf8")) !==
      0
    ) {
      undoStack.push(entry);
      return c.json(
        { error: "適用後にファイルが変更されているため取り消せません。" },
        409
      );
    }
    await writeFile(entry.file, entry.previousContent, "utf8");
    return c.json({
      ok: true,
      file: entry.file,
      relFile: entry.relFile,
      summary: `${entry.relFile} の適用を取り消しました。`,
      undoDepth: undoStack.length,
    });
  } catch (e) {
    undoStack.push(entry);
    return serverError(c, e, entry.relFile);
  } finally {
    inFlight.delete(entry.proposalId);
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
  } catch (e) {
    return serverError(c, e);
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
  } catch (e) {
    return serverError(c, e);
  }
});
