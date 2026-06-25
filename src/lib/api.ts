import type { DomDescriptor, EditResult, ProjectInfo } from "./types.ts";

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
  edit: (descriptor: DomDescriptor, instruction: string) =>
    post<EditResult>("/api/edit", { descriptor, instruction }),
};
