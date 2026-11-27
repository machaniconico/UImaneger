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
| 実プロセス検証済み(CI) | Next.js、Nuxt、React Router、Remix、SvelteKit、Astro、Angular、Vue CLI、Create React App、Vite + React、静的 HTML、汎用 Node `dev` script | Ubuntu / Windows の runtime matrix で毎 push 実行(初回 PASS: 2026-11-27、commit `469ae1c`) |
| 実プロセス検証済み(CI) | Django、Laravel、PHP (`index.php`)、Go、Spring Boot (Maven/Gradle)、ASP.NET Core | Ubuntu の runtime matrix で毎 push 実行(初回 PASS: 2026-11-27、commit `469ae1c`)。Windows では未実行 |
| 自動起動プラン検証済み | Rails、Phoenix | Runtime matrix の fixture あり・実プロセス未実行。CI 対象外 |
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

前提は Node.js 22.18 以上 25 未満(TypeScript の型注釈除去を既定で使うため)、npm 10 以上です。対象プロジェクト側の runtime と依存関係は別途必要です。

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

UI の Vite は `strictPort` で起動するため、5173(`UIM_CLIENT_PORT`)が使用中なら別ポートへ逃げずに起動失敗します。API はこのポートの Origin だけを UI として信頼するので、変更する場合は `.env` の `UIM_CLIENT_PORT` を書き換えてください。

ビルド済み UI をサーバ 1 つで配信する場合は `npm run start:prod` を使います(`npm run build` の後に `--production` 付きで起動)。このモードでは UI と API が同一 origin(既定 [http://localhost:5174](http://localhost:5174))になり、5173 の Origin は信頼しません。`npm start` 単独は API のみの開発用モードです。

Git clone 後の Node 依存導入は npm/pnpm/Yarn/Bun を検出し、lifecycle script を無効にして実行します(pnpm は `.pnpmfile.cjs` も無効)。Yarn 2 以降はリポジトリの `.yarnrc.yml` が指す `yarnPath` や plugin を Yarn 自身が読み込むため、install 時点でそのリポジトリのコードが動く可能性があります。Ruby、Python、PHP、Go、Java、.NET、Elixir などの依存導入は自動化していません。
Clone URL は HTTPS、SSH URL、scp-like `git@host:path` のみ受け付けます。平文の Git protocol、ローカル `file:`、Git ext transport は拒否します。

## セキュリティ

このアプリはローカル単一ユーザー向けです。認証付きの共有サービスではありません。

- コントロール API とプレビュープロキシは既定で `127.0.0.1` のみに bind します。
- コントロール API は、Origin ヘッダがある場合 UI の origin(`http://{localhost|127.0.0.1|[::1]}:{UIM_SERVER_PORT}`、開発時はさらに `UIM_CLIENT_PORT`)と完全一致したものだけを受け付けます。別ポートの localhost ページ、`null`、`https`、`*.localhost` は 403 です。許可 Origin は起動ログに出力します。
- Host はホスト名 `localhost`、`127.0.0.1`、`::1` のみ許可します(ポートは問いません。`*.localhost` は対象外)。`Sec-Fetch-Site` が `same-site` / `cross-site` の要求も拒否します。CORS 応答ヘッダは出しません。
- 状態を変更する API(GET/HEAD/OPTIONS 以外)は `Content-Type: application/json` を必須とし、それ以外は 415 を返します。フォームや `text/plain` の単純リクエストによる CSRF を防ぐためです。
- プレビュープロキシも、Host がループバック名でない要求と、Origin がプロキシ自身の origin(`http://{localhost|127.0.0.1|[::1]}:{プロキシのポート}`)と一致しない要求を、HTTP・WebSocket とも 403 で拒否します(DNS rebinding 対策)。
- 対象 dev server のポートへの直接アクセスはプレビュープロキシを通らないため、Host 検査は対象フレームワーク側に依存します。
- 開発サーバ、git、依存インストールなどの子プロセスには、`ANTHROPIC_*`、`UIM_*` と `.env` から読み込んだキーを渡しません。
- 任意の起動コマンドは、サーバ自体もループバック bind の場合にだけ許可します。
- Clone したプロジェクトの install では lifecycle script と pnpm の `.pnpmfile.cjs` を無効化します。ただし Yarn 2 以降の `yarnPath`・plugin は install 時に読み込まれ、clone 後は検出した開発サーバも自動起動するため、そのプロジェクトのコードが現在ユーザー権限で実行されます。信頼できるリポジトリだけを開いてください。
- 編集時は対象ファイル全体、指示、DOM の補助情報が Anthropic API へ送信されます。秘密、個人情報、契約上送信できないコードを対象にしないでください。
- 想定する脅威、対策、受容したリスクは [THREAT_MODEL.md](./compliance/THREAT_MODEL.md) にまとめています。
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
npm run notices
npm run e2e          # 実ブラウザ E2E(Chromium)
npm run e2e:all      # Chromium / Firefox / WebKit(WebKit は Linux で `npx playwright install --with-deps webkit` が必要)
```

`npm run verify` は依存ポリシー、型検査、runner/resolver selftest、Vitest、production build を実行します。実 API キーを使うブラウザ全体の編集フローは CI 対象外です。

### Runtime matrix

2026-11-27 のローカル実測は WSL2 / Node 22 で 19 PASS、2 SKIP、0 FAIL でした。Rails と Phoenix は必要なランタイムや CLI がなく SKIP でした。

`npm run runtime-matrix` は一時ディレクトリに fixture を生成し、本体の自動検出で起動します。トップページの HTTP 200 と fixture 固有のマーカーを確認します。Vite + React、Create React App、Vue CLI、Angular は配信された JavaScript にも同じマーカーが含まれることを確認します。停止後はプロセスツリーとポートの解放を検証します。依存の取得にはネットワーク接続が必要です。Django は一時 `.venv` に導入し、本体が検出した Python で起動します。

```bash
npm run runtime-matrix
RUNTIME_MATRIX_REQUIRE=node,python npm run runtime-matrix -- --only=node,python
npm run --silent runtime-matrix -- --json > runtime-matrix.json
```

`--only` と `RUNTIME_MATRIX_REQUIRE` には `node,python,php,go,java,dotnet,ruby,elixir` を指定できます。必要な runtime や CLI が無い構成は理由付きの `SKIP` になり、`RUNTIME_MATRIX_REQUIRE` で指定した構成の `SKIP` は失敗になります。Spring Boot は JDK と Maven / Gradle、ASP.NET Core は .NET 10 SDK を使用します。JSON には Node のトップレベル依存と Django の仮想環境で解決されたパッケージのバージョンを記録します。GitHub Actions の `runtime-matrix` job は OS ごとの JSON を artifact として保存します。

詳細な現在仕様は [SPEC.md](./SPEC.md) を参照してください。
販売前の未解決ゲートは [COMMERCIAL_READINESS.md](./compliance/COMMERCIAL_READINESS.md)、外部サービスの確認記録は [THIRD_PARTY_SERVICES.md](./compliance/THIRD_PARTY_SERVICES.md) を参照してください。
