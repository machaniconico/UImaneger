import type {
  Candidate,
  DomDescriptor,
  EditProposal,
  ProjectInfo,
} from "./types.ts";

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
    throw new ApiError(
      serverError || `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
      {
        status: res.status,
        statusText: res.statusText,
        serverError,
        bodyText,
      }
    );
  }
  try {
    return (await res.json()) as T;
  } catch (e: any) {
    throw new Error(`HTTP ${res.status}: invalid JSON (${e?.message || e})`);
  }
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson<T>(res);
}

export interface StatusResp {
  info: ProjectInfo | null;
  hasKey: boolean;
  logs: string[];
  undoDepth?: number;
}

export interface GitStatusResp {
  changes: string[];
}

export const api = {
  status: (): Promise<StatusResp> =>
    fetch("/api/status").then((r) => parseJson<StatusResp>(r)),
  open: (path: string, runCommand?: string) =>
    post<{ info?: ProjectInfo; error?: string }>("/api/project/open", {
      path,
      runCommand,
    }),
  clone: (repo: string, runCommand?: string) =>
    post<{ info?: ProjectInfo; error?: string }>("/api/project/clone", {
      repo,
      runCommand,
    }),
  start: () => post<{ info?: ProjectInfo; error?: string }>("/api/project/start", {}),
  stop: () => post<{ info: ProjectInfo | null }>("/api/project/stop", {}),

  /** 指示 → 提案(差分)を取得。まだ適用しない。 */
  edit: (descriptor: DomDescriptor, instruction: string) =>
    post<EditProposal>("/api/edit", { descriptor, instruction }),
  /** 候補ファイルを指定して提案を作る。 */
  editCandidate: (
    candidate: Candidate,
    descriptor: DomDescriptor,
    instruction: string
  ) =>
    post<EditProposal>("/api/edit/candidate", {
      file: candidate.file,
      line: candidate.line,
      descriptor,
      instruction,
    }),
  /** 提案を適用(実書き込み)。 */
  applyEdit: (proposalId: string) =>
    post<{
      ok: boolean;
      file?: string;
      relFile?: string;
      error?: string;
      undoDepth?: number;
    }>("/api/edit/apply", { proposalId }),
  rejectEdit: (proposalId: string) =>
    post<{ ok: boolean; error?: string }>("/api/edit/reject", { proposalId }),
  undoEdit: () =>
    post<{ ok: boolean; relFile?: string; error?: string; undoDepth?: number }>(
      "/api/edit/undo",
      {}
    ),
  gitStatus: (): Promise<GitStatusResp> =>
    fetch("/api/git/status").then((r) => parseJson<GitStatusResp>(r)),
  gitCommit: (message: string) =>
    post<{ ok: boolean }>("/api/git/commit", { message }),
};
