import type {
  Candidate,
  DomDescriptor,
  EditProposal,
  ProjectInfo,
} from "./types.ts";

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

export interface StatusResp {
  info: ProjectInfo | null;
  hasKey: boolean;
  logs: string[];
}

export const api = {
  status: (): Promise<StatusResp> => fetch("/api/status").then((r) => r.json()),
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
    post<{ ok: boolean; file?: string; relFile?: string; error?: string }>(
      "/api/edit/apply",
      { proposalId }
    ),
  rejectEdit: (proposalId: string) =>
    post<{ ok: boolean; error?: string }>("/api/edit/reject", { proposalId }),
  undoEdit: () =>
    post<{ ok: boolean; relFile?: string; error?: string }>(
      "/api/edit/undo",
      {}
    ),
};
