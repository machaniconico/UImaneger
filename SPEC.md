# UImaneger Current Specification

この文書は現在の実装契約を記述します。将来構想ではありません。

## Product Boundary

UImaneger は、信頼できるコードをローカルで扱う単一ユーザー向け開発ツールです。対象プロジェクトの開発サーバを子プロセスとして起動し、HTTP プロキシ経由で before/after プレビューを表示します。共有ホスティング、認証付き SaaS、本番サイト編集は対象外です。

基本フロー:

1. ローカルディレクトリまたは Git URL を開く。
2. 起動方法を検出するか、ユーザー指定コマンドを実行する。
3. Git HEAD の before と作業ツリーの after を別ポートで配信する。
4. プレビューで要素を選択し、ソース位置または候補を解決する。
5. Claude API が返したファイル全体から unified diff を作る。
6. ユーザー承認後だけ atomic write し、undo 情報を保持する。

## Runtime Detection

判定優先順位は、強いバックエンド指標、Node framework/package script、汎用ファイル指標です。Rails などが Vite を資産ビルドに併用していても、アプリサーバを優先します。

自動判定:

- Node: Next.js、Nuxt、React Router、Remix、SvelteKit、Astro、Vite、Angular、Vue CLI、Create React App、`dev`/`start` script
- Backend: Rails、Django、Laravel、PHP、Go、Spring Boot Maven/Gradle、ASP.NET Core、Phoenix
- Static: 同梱の read-only HTTP server

汎用ライブラリをサーバとして誤起動しないため、Go はルートの `package main` と `func main`、PHP は `index.php`、Django は標準的な `manage.py` を要求します。Django はプロジェクト直下の `.venv`、`venv`、PATH 上の `python` の順に起動用の Python を選びます。

Node の package manager は `packageManager`、pnpm/Yarn/Bun lockfile、npm fallback の順で決めます。Windows の `.cmd`/`.bat` と package-manager shim は `cmd.exe` 経由で起動します。待受は `127.0.0.1` と `::1` の実アドレスを確認し、既存 listener を対象プロセスと誤認しません。

手動コマンドは単一行 2,000 文字までです。ループバック bind とローカル Host の両方を満たす要求だけ受理し、`PORT` を環境変数で渡します。

## Preview Proxy

- HTTP request/response と WebSocket upgrade を中継する。
- target の実待受アドレスが IPv4/IPv6 のどちらかを保持する。
- target 自身への absolute redirect は `http://localhost:<proxyPort>` へ直す。
- UTF-8/ASCII `text/html` に `<script src="/__uim/inspector.js">` をストリーム注入する。
- Inspector script は proxy origin から `no-store` で配信する。
- HTML の既存 CSP directive を維持し、`frame-ancestors` と同一 origin script 許可だけを補正する。
- XHTML、非 UTF-8、圧縮済み response は byte-preserving pass-through とする。
- non-HTML と content-type 不明の non-HTML は全量 buffer しない。
- HEAD、1xx、204、304 に body を注入しない。

厳格な meta CSP、nonce + `strict-dynamic`、closed Shadow DOM、cross-origin nested iframe は Inspector 非対応です。

## Inspector Descriptor

Inspector は localhost family の親 origin と handshake した後だけ `postMessage` します。wildcard target origin は使いません。

```ts
interface DomDescriptor {
  tag: string;
  id?: string;
  classes: string[];
  attrs: Record<string, string>;
  textSnippet?: string;
  domPath: string;
  rect?: { x: number; y: number; width: number; height: number };
  source?: { fileName: string; lineNumber: number; columnNumber?: number };
  vue?: { framework: string; name: string; props?: Record<string, primitive> };
  svelte?: { framework: string; source?: Partial<SourceLocation> };
  hints?: Record<string, string>;
}
```

Pointer event は `composedPath()` の最内側 Element を使用し、open Shadow Root は keyboard candidate 収集でも再帰走査します。

## Source Resolution

実装は2段階です。

1. Source metadata: absolute path、project-relative path、`/src/...`、`file:` URL を project root 内の実在ファイルへ正規化する。有効な line 範囲なら high confidence。
2. Heuristic search: text、id、安定属性、Vue component 名、固有 class を ripgrep または Node fallback で検索し、希少性と authoring file を加味して順位付けする。

候補同率、弱い信号、JSON/CSS など非 authoring file の一致は low confidence とし、モデル編集を開始せず候補選択を要求します。source line が現在のファイル範囲外なら candidate で再検証して medium 以下に落とします。

React の `_debugSource`、Vue/Svelte の private runtime property は存在する場合だけ補助的に利用します。React 19、Angular、production/minified build に対する精密 adapter は実装済みとは見なしません。

## Edit Safety

- API body は 2 MiB まで。
- descriptor と instruction を型検証する。
- realpath により project root 外と symlink escape を拒否する。
- UTF-8 でないファイルは編集しない。
- CRLF と UTF-8 BOM を維持する。
- proposal はメモリ内 TTL 30 分、最大 100 件。
- apply は original bytes を比較し、外部変更後の stale proposal を拒否する。
- file 単位 lock と proposal 単位 in-flight guard で二重適用を防ぐ。
- atomic rename 後に undo entry を最大 50 件保持する。

## Clone And Dependencies

許可する remote は HTTPS、SSH、scp-like `git@host:path` です。平文の Git protocol、`file:`、Git ext transport、option-like input は拒否します。Clone は depth 1、非対話、120 秒 timeout で実行し、URL fingerprint を directory 名へ含めます。既存 directory は `.git` と origin 一致を確認します。

Node dependency install は lifecycle script を無効化し、5 分 timeout で実行します。非 Node dependency install と複数候補 monorepo の app 選択は自動化しません。

## Verification Levels

- Runtime integration: Vite + React sample、generic Node server、bundled static server、proxy HTTP/WebSocket/streaming
- Unit/integration: framework plan、package manager、resolver、API proposal/apply/undo、security middleware、React UI
- Build gate: package policy、TypeScript、selftests、Vitest、Vite production build
- Runtime matrix は `npm run runtime-matrix` で本体の自動起動、HTTP 応答、プロセスツリーとポートの解放を検証します。Vite + React、Create React App、Vue CLI、Angular は配信 JavaScript 内のマーカーも検証します。2026-11-27 の WSL2 / Node 22 での実測は 19 PASS、2 SKIP、0 FAIL です。SKIP の Rails と Phoenix は CI(Ubuntu、Ruby 3.4 / Elixir 1.18)で実起動して検証します。CI 対象は README の対応範囲を参照してください。
- Not automated: real Anthropic request、browser click-to-edit full flow、installer/signing

## Commercial Status

この repository の現状は `COMMERCIAL-READINESS: BLOCKED` です。理由は、製品ライセンス方針、第三者 notice/SBOM の出荷手順、Anthropic 利用に伴う privacy/terms、配布 artifact、コード署名、実ブラウザ E2E、サポート/更新/脆弱性受付の運用が未確定だからです。テスト成功だけを販売可能の証明にはしません。
