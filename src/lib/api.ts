import type {
  Candidate,
  DomDescriptor,
  EditProposal,
  HistoryEntry,
  ProjectInfo,
} from "./types.ts";
import { SERVER_UNREACHABLE_MESSAGE, isNetworkError } from "./network.ts";

/** apply / undo / redo などの通常 JSON 呼び出しのタイムアウト */
export const REQUEST_TIMEOUT_MS = 30_000;
/** 編集ストリームが何も受信しない時間の上限 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

function abortError(): DOMException {
  return new DOMException("中止しました", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** fetch の通信失敗を日本語の案内にする(中断・その他はそのまま)。 */
function translateFetchError(error: unknown): unknown {
  return isNetworkError(error) ? new Error(SERVER_UNREACHABLE_MESSAGE) : error;
}

/** ステータスコード別の日本語メッセージ。サーバが分かる日本語を返していればそれを優先する。 */
function httpErrorMessage(status: number, serverError: string): string {
  const english = new Set(["forbidden", "unsupported media type"]);
  if (serverError && !english.has(serverError.toLowerCase())) return serverError;
  if (status === 403)
    return "この操作は許可されていません（HTTP 403）。アクセス元のオリジンを確認してください";
  if (status === 413) return "送信内容が大きすぎます（HTTP 413）";
  if (status === 415) return "対応していない形式のリクエストです（HTTP 415）";
  if (status >= 500) return `サーバでエラーが発生しました（HTTP ${status}）`;
  return `リクエストに失敗しました（HTTP ${status}）`;
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly serverError: string;
  readonly bodyText: string;

  constructor(
    message: string,
    options: {
      status: number;
      statusText: string;
      serverError?: string;
      bodyText?: string;
    }
  ) {
    super(message);
    this.name = "ApiError";
    this.status = options.status;
    this.statusText = options.statusText;
    this.serverError = options.serverError ?? "";
    this.bodyText = options.bodyText ?? "";
  }
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Response が HTTP エラーなら例外を投げ、成功なら JSON を返す。 */
async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let serverError = "";
    let bodyText = "";
    try {
      bodyText = await res.text();
      try {
        const j = JSON.parse(bodyText);
        serverError = j && typeof j.error === "string" ? j.error : "";
      } catch {
        // JSON でない、または error フィールドがない場合は status のみを表示する
      }
    } catch {
      // ボディ読み取り失敗は status のみを表示する
    }
    throw new ApiError(httpErrorMessage(res.status, serverError), {
      status: res.status,
      statusText: res.statusText,
      serverError,
      bodyText,
    });
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`サーバの応答を解析できませんでした（HTTP ${res.status}）`);
  }
}

/** GET。通信失敗だけ日本語の案内にする。 */
async function get<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw translateFetchError(e);
  }
  return parseJson<T>(res);
}

/**
 * POST。timeoutMs 経過で中断してエラーにし、呼び出し側の signal でも中断できる。
 * 中断理由が呼び出し側なら AbortError、タイムアウトなら日本語の通常 Error を投げる。
 */
async function post<T>(
  url: string,
  body: unknown,
  signal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return await parseJson<T>(res);
  } catch (e) {
    if (timedOut)
      throw new Error(
        `サーバの応答がありません（${REQUEST_TIMEOUT_MS / 1000}秒でタイムアウトしました）`
      );
    if (signal?.aborted) throw abortError();
    throw translateFetchError(e);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export interface StatusResp {
  info: ProjectInfo | null;
  hasKey: boolean;
  logs: string[];
  undoDepth?: number;
  redoDepth?: number;
  historyCount?: number;
}

export interface EditStreamBody {
  descriptor: DomDescriptor;
  instruction: string;
  previousProposalId?: string;
  model?: string;
}

export interface EditModel {
  id: string;
  label: string;
  note: string;
}

export interface ModelsResp {
  models: EditModel[];
  default: string;
}

export interface EditStreamHandlers {
  onStage: (event: {
    stage: "resolving" | "generating";
    file?: string;
  }) => void;
  onProgress: (event: { chars: number; tail: string }) => void;
}

export interface EditStreamOptions {
  /** 呼び出し側からの中止用 */
  signal?: AbortSignal;
}

async function editStream(
  body: EditStreamBody,
  handlers: EditStreamHandlers,
  options: EditStreamOptions = {}
): Promise<EditProposal> {
  const controller = new AbortController();
  let idleTimedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // fetch・read のどちらが待機中でも中断を即座に伝えるため、abort を reject する Promise と競わせる
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAborted = reject;
  });
  aborted.catch(() => {});
  const fail = (reason: unknown) => {
    controller.abort();
    rejectAborted(reason);
  };
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      fail(
        new Error(
          `編集ストリームが${STREAM_IDLE_TIMEOUT_MS / 1000}秒間何も受信しなかったため中断しました`
        )
      );
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  const onAbort = () => fail(abortError());
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });
  resetIdle();

  try {
    let res: Response;
    try {
      res = await Promise.race([
        fetch("/api/edit/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        aborted,
      ]);
    } catch (e) {
      throw idleTimedOut || isAbortError(e) ? e : translateFetchError(e);
    }
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).trim();
      } catch {
        // status だけでも十分に診断できるメッセージを返す
      }
      throw new Error(
        `編集ストリームの開始に失敗しました（HTTP ${res.status}${
          detail ? `: ${detail}` : ""
        }）`
      );
    }
    if (!res.body) {
      throw new Error("編集ストリームの応答本文を読み取れませんでした");
    }
    return await readEditStream(res.body.getReader(), handlers, aborted, resetIdle);
  } finally {
    clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function readEditStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  handlers: EditStreamHandlers,
  aborted: Promise<never>,
  onChunk: () => void
): Promise<EditProposal> {
  const decoder = new TextDecoder();
  let buffer = "";
  let result: EditProposal | undefined;

  const processFrame = (frame: string) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    if (dataLines.length === 0) return;

    let event: unknown;
    try {
      event = JSON.parse(dataLines.join("\n"));
    } catch (error) {
      throw new Error(
        `編集ストリームのイベントを解析できませんでした: ${String(
          (error as Error)?.message || error
        )}`
      );
    }
    if (!event || typeof event !== "object" || !("type" in event)) return;

    const payload = event as Record<string, unknown>;
    if (
      payload.type === "stage" &&
      (payload.stage === "resolving" || payload.stage === "generating")
    ) {
      handlers.onStage({
        stage: payload.stage,
        ...(typeof payload.file === "string" ? { file: payload.file } : {}),
      });
    } else if (
      payload.type === "progress" &&
      typeof payload.chars === "number" &&
      typeof payload.tail === "string"
    ) {
      handlers.onProgress({ chars: payload.chars, tail: payload.tail });
    } else if (payload.type === "result") {
      const { type: _type, ...finalResult } = payload;
      result = finalResult as unknown as EditProposal;
    }
  };

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      onChunk();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator =
          buffer.slice(boundary).match(/^(?:\r?\n){2}/)?.[0] ?? "\n\n";
        buffer = buffer.slice(boundary + separator.length);
        processFrame(frame);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (result || done) break;
    }

    if (!result && buffer.trim()) processFrame(buffer);
    if (!result) {
      throw new Error("編集ストリームが完了しましたが、最終結果を受信できませんでした");
    }
    return result;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export interface GitStatusResp {
  changes: string[];
}

export const api = {
  getModels: (): Promise<ModelsResp> => get<ModelsResp>("/api/models"),
  status: (): Promise<StatusResp> => get<StatusResp>("/api/status"),
  open: (path: string, runCommand?: string) =>
    post<{ info?: ProjectInfo; error?: string }>("/api/project/open", {
      path,
      runCommand,
    }),
  clone: (repo: string, runCommand?: string) =>
    post<{ info?: ProjectInfo; error?: string; warning?: string }>("/api/project/clone", {
      repo,
      runCommand,
    }),
  start: () => post<{ info?: ProjectInfo; error?: string }>("/api/project/start", {}),
  stop: () => post<{ info: ProjectInfo | null }>("/api/project/stop", {}),

  /** 指示 → 提案(差分)を取得。まだ適用しない。 */
  edit: (descriptor: DomDescriptor, instruction: string) =>
    post<EditProposal>("/api/edit", { descriptor, instruction }),
  editStream,
  /** 候補ファイルを指定して提案を作る。 */
  editCandidate: (
    candidate: Candidate,
    descriptor: DomDescriptor,
    instruction: string,
    model?: string,
    signal?: AbortSignal
  ) =>
    post<EditProposal>(
      "/api/edit/candidate",
      {
        file: candidate.file,
        line: candidate.line,
        descriptor,
        instruction,
        ...(model ? { model } : {}),
      },
      signal
    ),
  /** 提案を適用(実書き込み)。 */
  applyEdit: (proposalId: string, signal?: AbortSignal) =>
    post<{
      ok: boolean;
      file?: string;
      relFile?: string;
      error?: string;
      undoDepth?: number;
    }>("/api/edit/apply", { proposalId }, signal),
  rejectEdit: (proposalId: string) =>
    post<{ ok: boolean; error?: string }>("/api/edit/reject", { proposalId }),
  undoEdit: (signal?: AbortSignal) =>
    post<{
      ok: boolean;
      relFile?: string;
      error?: string;
      undoDepth?: number;
      redoDepth?: number;
    }>(
      "/api/edit/undo",
      {},
      signal
    ),
  gitStatus: (): Promise<GitStatusResp> =>
    get<GitStatusResp>("/api/git/status"),
  gitCommit: (message: string) =>
    post<{ ok: boolean }>("/api/git/commit", { message }),
  redoEdit: (signal?: AbortSignal) =>
    post<{
      ok: boolean;
      relFile?: string;
      error?: string;
      undoDepth?: number;
      redoDepth?: number;
    }>("/api/edit/redo", {}, signal),
  editHistory: () => get<{ history: HistoryEntry[] }>("/api/edit/history"),
};
