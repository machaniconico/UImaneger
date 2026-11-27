# UImaneger

ローカルで動く、リアルタイムプレビューと自然言語UI編集のツールです。対象プロジェクトを開発サーバで起動し、プレビュー上で選んだ要素に対する変更案を差分で確認してから適用できます。

## 主な機能

- ローカルパスまたは Git リポジトリ URL を開く
- 左に操作、中央に編集前、右に変更後を表示
- 要素選択からソース候補を検索し、Claude API で変更案を生成
- 差分の承認、却下、undo
- npm、pnpm、Yarn、Bun のプロジェクト宣言または lockfile を尊重
- IPv4/IPv6 ループバック、WebSocket/HMR、UTF-8 HTML ストリーミングに対応

## 対応範囲

「自動起動」と「選択要素からのソース特定」は別の機能です。自動起動できても、常に正確な file:line を取得できるわけではありません。

| 区分 | 対象 | 現在の検証状態 |
|---|---|---|
| 実プロセス検証済み | Vite + React の同梱サンプル、静的 HTML、汎用 Node `dev` script | Windows の CI 相当テストで起動と HTTP 応答を確認 |
| 自動起動プラン検証済み | Next.js、Nuxt、React Router、Remix、SvelteKit、Astro、Angular、Vue CLI、Create React App | コマンド、port、package manager の判定を単体テストで確認 |
| 自動起動プラン検証済み | Rails、Django、Laravel/PHP、Go、Spring Boot (Maven/Gradle)、ASP.NET Core、Phoenix | 強いプロジェクト指標と起動プランを単体テストで確認。各 runtime での実起動は環境別確認が必要 |
| 手動コマンド | FastAPI/Flask の任意 entrypoint、Rust Web、Java の非 Spring 構成、独自サーバ、複数アプリの monorepo | 「起動設定」でコマンドを指定。`PORT` 環境変数が渡される |

自動判定は誤起動を避けるため、強いマーカーがある構成に限定しています。Go はルートの `package main` と `func main`、PHP は `index.php`、Django は標準的な `manage.py` を確認します。monorepo でルートに起動 script がない場合は、対象アプリのディレクトリをローカルパスとして開いてください。

### ソース特定

1. runtime から実在する project 内 source path と line が得られた場合は高確度で採用します。
2. それ以外は text、id、固有 class、`data-testid`、`aria-label`、Vue component 名などを検索して候補を評価します。
3. 曖昧な一致や JSON/CSS など非テンプレートファイルの一致は自動編集せず、候補選択を求めます。

React の private `fiber._debugSource` は React/version/build 設定に依存し、React 19 での精密解決は保証しません。Vue/Svelte の runtime metadata も補助信号です。Angular 専用の精密アダプタは未実装です。

対象テンプレートには TSX/JSX、Vue、Svelte、Astro、HTML、ERB、Blade/PHP、Razor/CSHTML、JSP、Twig、Jinja、Liquid、HEEx などを含みます。ビルド済み・minify 済み成果物から元ソースを完全に復元する機能ではありません。

### プレビュー制約

- Inspector 注入対象は identity encoding の UTF-8/ASCII `text/html` です。
- `application/xhtml+xml`、非 UTF-8 HTML、upstream が圧縮を強制した HTML は壊さず中継しますが、要素選択は利用できません。
- 既存 CSP は維持し、同一 origin の Inspector script を許可します。meta CSP、nonce + `strict-dynamic` など特に厳しいポリシーでは注入がブロックされる場合があります。
- open Shadow DOM は選択できます。closed Shadow DOM と cross-origin の子 iframe 内部は対象外です。

## セットアップ

前提は Node.js 22.12 以上 25 未満、npm 10 以上です。対象プロジェクト側の runtime と依存関係は別途必要です。

```bash
npm install
npm run dev
```

先に `.env.example` を `.env` へ複製してください。PowerShell では
`Copy-Item .env.example .env`、bash では `cp .env.example .env` を使えます。

`.env` に `ANTHROPIC_API_KEY` を設定し、ブラウザで [http://localhost:5173](http://localhost:5173) を開きます。同梱サンプルは次の絶対パスで開けます。

```text
<repository>/examples/sample-app
```

Git clone 後の Node 依存導入は npm/pnpm/Yarn/Bun を検出し、lifecycle script を無効にして実行します。Ruby、Python、PHP、Go、Java、.NET、Elixir などの依存導入は自動化していません。
Clone URL は HTTPS、SSH URL、scp-like `git@host:path` のみ受け付けます。平文の Git protocol、ローカル `file:`、Git ext transport は拒否します。

## セキュリティ

このアプリはローカル単一ユーザー向けです。認証付きの共有サービスではありません。

- コントロール API とプレビュープロキシは既定で `127.0.0.1` のみに bind します。
- Origin/Host allowlist は `localhost`、`127.0.0.1`、`::1`、`*.localhost` に限定します。
- 任意の起動コマンドは、サーバ自体もループバック bind の場合にだけ許可します。
- Clone したプロジェクトの install script は無効化します。ただし開発サーバを起動すると、そのプロジェクトのコードが現在ユーザー権限で実行されます。信頼できるコードだけを開いてください。
- 編集時は対象ファイル全体、指示、DOM の補助情報が Anthropic API へ送信されます。秘密、個人情報、契約上送信できないコードを対象にしないでください。
- `UIM_HOST` による LAN 公開はサポート対象外です。認証やTLSなしで外部公開しないでください。

## 開発と検証

```bash
npm run policy
npm run typecheck
npm run test:ci
npm run build
npm run verify
npm run sbom
npm run audit
```

`npm run verify` は依存ポリシー、型検査、runner/resolver selftest、Vitest、production build を実行します。実 API キーを使うブラウザ全体の編集フローと、各バックエンド runtime の実起動マトリクスは CI では未検証です。

詳細な現在仕様は [SPEC.md](./SPEC.md) を参照してください。
販売前の未解決ゲートは [COMMERCIAL_READINESS.md](./compliance/COMMERCIAL_READINESS.md)、外部サービスの確認記録は [THIRD_PARTY_SERVICES.md](./compliance/THIRD_PARTY_SERVICES.md) を参照してください。
