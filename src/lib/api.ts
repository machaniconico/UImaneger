import type {
  Candidate,
  DomDescriptor,
  EditProposal,
  HistoryEntry,
  ProjectInfo,
} from "./types.ts";

/** Response が HTTP エラーなら例外を投げ、成功なら JSON を返す。 */
async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let serverError = "";
    try {
      const body = await res.text();
      try {
        const j = JSON.parse(body);
        serverError = j && typeof j.error === "string" ? j.error : "";
      } catch {
        // JSON でない、または error フィールドがない場合は status のみを表示する
      }
    } catch {
      // ボディ読み取り失敗は status のみを表示する
    }
    if (serverError) throw new Error(serverError);
    throw new Error(`HTTP ${res.status}`);
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
  redoDepth?: number;
  historyCount?: number;
}

export interface EditStreamBody {
  descriptor: DomDescriptor;
  instruction: string;
  previousProposalId?: string;
}

export interface EditStreamHandlers {
  onStage: (event: {
    stage: "resolving" | "generating";
    file?: string;
  }) => void;
  onProgress: (event: { chars: number; tail: string }) => void;
}

async function editStream(
  body: EditStreamBody,
  handlers: EditStreamHandlers
): Promise<EditProposal> {
  const res = await fetch("/api/edit/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

  const reader = res.body.getReader();
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

  while (true) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let boundary = buffer.search(/\r?\n\r?\n/);
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      const separator = buffer.slice(boundary).match(/^(?:\r?\n){2}/)?.[0] ?? "\n\n";
      buffer = buffer.slice(boundary + separator.length);
      processFrame(frame);
      boundary = buffer.search(/\r?\n\r?\n/);
    }
    if (done) break;
  }

  if (buffer.trim()) processFrame(buffer);
  if (!result) {
    throw new Error("編集ストリームが完了しましたが、最終結果を受信できませんでした");
  }
  return result;
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
  editStream,
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
    post<{
      ok: boolean;
      relFile?: string;
      error?: string;
      undoDepth?: number;
      redoDepth?: number;
    }>(
      "/api/edit/undo",
      {}
    ),
  redoEdit: () =>
    post<{
      ok: boolean;
      relFile?: string;
      error?: string;
      undoDepth?: number;
      redoDepth?: number;
    }>("/api/edit/redo", {}),
  editHistory: () =>
    fetch("/api/edit/history").then((r) =>
      parseJson<{ history: HistoryEntry[] }>(r)
    ),
};
