export interface DomDescriptor {
  tag: string;
  id?: string;
  classes: string[];
  attrs: Record<string, string>;
  textSnippet?: string;
  domPath: string;
  rect?: { x: number; y: number; width: number; height: number };
  source?: { fileName: string; lineNumber: number; columnNumber?: number };
}

export type GitMode = "worktree" | "snapshot" | "none";

export interface ProjectInfo {
  root: string;
  name: string;
  framework: string;
  runCommand: string;
  running: boolean;
  /** 編集前(HEAD)を配信するプロキシポート */
  beforeProxyPort: number | null;
  /** 変更後(作業ツリー)を配信するプロキシポート */
  afterProxyPort: number | null;
  targetPortBefore: number | null;
  targetPortAfter: number | null;
  gitMode: GitMode | null;
  beforeError?: string | null;
}

export interface Candidate {
  file: string;
  line: number;
  preview: string;
}

/** /api/edit が返す提案 (適用はまだ) */
export interface EditProposal {
  ok: boolean;
  error?: string;
  proposalId?: string;
  file?: string;
  relFile?: string;
  line?: number;
  confidence?: "high" | "medium" | "low";
  diff?: string;
  summary?: string;
  candidates?: Candidate[];
}

export interface HistoryEntry {
  id: string;
  relFile: string;
  summary?: string;
  instruction?: string;
  appliedAt: string;
  kind: "apply" | "undo" | "redo";
}

/** 後方互換: 旧 EditResult を EditProposal の別名に */
export type EditResult = EditProposal;
