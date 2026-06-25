/** iframe 内 inspector が収集する要素の記述子 (言語非依存) */
export interface DomDescriptor {
  tag: string;
  id?: string;
  classes: string[];
  attrs: Record<string, string>;
  textSnippet?: string;
  domPath: string; // nth-child ベースの CSS パス
  rect?: { x: number; y: number; width: number; height: number };
  /** 層A: フレームワークが source 位置を出せた場合のみ */
  source?: { fileName: string; lineNumber: number; columnNumber?: number };
}

export interface ResolveResult {
  file: string;
  line?: number;
  col?: number;
  confidence: "high" | "medium" | "low";
  candidates?: { file: string; line: number; preview: string }[];
}

/**
 * クライアント側 src/lib/types.ts の ProjectInfo と共有される sharedContract。
 * 二重配信(before/after)のためのフィールドを追加しつつ、
 * 既存シングルターゲットAPIの互換性は targetPort/proxyPort で維持(after 側に合わせる)。
 */
export type GitMode = "worktree" | "snapshot" | "none";

export interface ProjectInfo {
  root: string;
  name: string;
  framework: string; // 検出したフレームワーク名 (表示用)
  runCommand: string; // 起動に使う serve コマンド
  // --- legacy single-target (下位互換; 値は after 側に合わせる) ---
  targetPort: number | null; // 対象 dev server の実ポート (after)
  proxyPort: number | null; // iframe が指すプロキシポート (after)
  running: boolean;
  // --- sharedContract: before/after 二重配信 ---
  beforeProxyPort: number | null; // before(編集前) 配信プロキシポート
  afterProxyPort: number | null; // after(変更後) 配信プロキシポート
  targetPortBefore: number | null; // before dev server 実ポート
  targetPortAfter: number | null; // after dev server 実ポート
  gitMode: GitMode | null; // before の配信モード
}
