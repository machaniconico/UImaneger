# Threat model

評価日: 2026-11-27(対象 commit: `01a1c28` 時点の `server/` と `src/`)

## 前提と範囲

UImaneger は **ローカル単一ユーザー** 向けのツールです。利用者本人の OS アカウントで動作し、認証付きの共有サービスとしては設計していません。

| 守るもの | 内容 |
|---|---|
| 利用者のファイル | 開いたプロジェクトと、それ以外の任意パス |
| 利用者の権限での実行 | 子プロセスの起動(git、パッケージマネージャ、対象 dev server) |
| 秘密情報 | `ANTHROPIC_API_KEY`、`.env` の値 |
| 対象プロジェクトのソース | プレビュー経由で読めるソースと dev server の応答 |

信頼境界は次のとおりです。

1. **ブラウザの別 origin**: 利用者が同じブラウザで開いている任意の Web ページ。localhost の別ポートで動く他アプリや、プレビュー中の対象アプリも含む。
2. **ネットワーク上の第三者**: DNS rebinding で loopback に到達しようとする外部サイト。
3. **開いたリポジトリのコード**: clone したプロジェクトの install 設定と dev server。
4. **Anthropic API**: 編集指示と対象ファイルの送信先(`THIRD_PARTY_SERVICES.md`)。

## 脅威と対策

| ID | 脅威 | 対策 | 証跡 |
|---|---|---|---|
| T1 | 別 origin のページが単純リクエスト(`text/plain`、`no-cors`)でコントロール API を叩き、clone 後の自動起動で任意コード実行、または `/api/files/write` で任意ファイルを書き換える(CSRF) | Origin を UI の origin(scheme・host・port)と完全一致で照合。状態を変えるメソッドは `application/json` を必須にし(415)、プリフライトを強制する。CORS ヘッダは一切返さない | `tests/acceptance/security-origin.test.ts`、`tests/acceptance/app-wiring.test.ts` |
| T2 | Origin の付かない `<img src=/api/git/status>` などの GET で、git の実行を誘発する | Fetch Metadata の `Sec-Fetch-Site` が `same-site`・`cross-site`・未知値なら 403 | `rejects_same_site_and_cross_site_get_without_origin`、`blocks_img_triggered_git_status` |
| T3 | DNS rebinding で外部サイトがコントロール API に到達する | Host を `localhost`・`127.0.0.1`・`[::1]` に限定(`*.localhost` と不正な authority は拒否)。dev 時は Vite の `changeOrigin: false` により、元の Host が API に届く | `allows_loopback_host_any_port`、`rejects_non_loopback_and_subdomain_host`、`server/vite-config.test.ts` |
| T4 | DNS rebinding でプレビュープロキシ経由の対象 dev server を読み、ソースや HMR WebSocket に到達する | プロキシは HTTP・upgrade とも、upstream に接続する前に Host と Origin を検査する。拒否経路のソケットエラーでプロセスが落ちないようにする | `tests/acceptance/proxy-host-origin.test.ts`、`server/lib/proxy.test.ts` |
| T5 | clone したプロジェクトのコードが、継承された `ANTHROPIC_API_KEY` を読み取って外部に送る | 子プロセスの env は `buildChildEnv` だけで作る。`ANTHROPIC_*`・`UIM_*`・`.env` 由来のキーを除去する | `tests/acceptance/child-env.test.ts`、`server/lib/child-env.test.ts` |
| T6 | 編集・適用・undo でプロジェクト root の外に書き込む(`..`、symlink、絶対パス) | `inRoot` が root とファイルの双方を realpath で解決し、外を拒否する。書き込みは rename による原子的置換で行う | `server/routes/api.test.ts` の traversal・symlink 脱出・候補ファイル範囲外の各テスト |
| T7 | clone URL によるコマンドや引数のインジェクション(先頭の `-`、`ext::`、`file:`) | HTTPS・SSH・scp 形式のみ受け付け、`--` で区切る。`protocol.ext.allow=never` と `GIT_ALLOW_PROTOCOL` を設定する | `server/routes/api.test.ts` |
| T8 | install 時にリポジトリのコードが走る | lifecycle script を無効化し、pnpm は `--ignore-pnpmfile` も付ける。Yarn 2 以降の `yarnPath` や plugin は止められないので、README に明記する | `server/lib/package-manager.test.ts`、README「セキュリティ」 |
| T9 | 一時ディレクトリの事前作成や名前の予測による乗っ取り | `mkdtempSync` で排他的に作成する | `server/lib/worktree.test.ts` |
| T10 | API キーがログやレスポンスに出る | `sanitizeForLog` で伏せ字にし、レスポンスにはキーを含めない | `server/routes/api.test.ts` |
| T11 | 依存パッケージの既知脆弱性、コードに混入した秘密、危険なコードパターン | CI の `audit`(moderate 以上)、`secret-scan`(gitleaks、git 履歴全体)、`sast`(semgrep)の各 job | `.github/workflows/ci.yml` |

## 受容したリスク(非目標)

- **同一 OS ユーザーのローカルプロセス**: 利用者と同じ権限を持つ時点で防御対象外です。トークン方式もこの相手には効きません。
- **開いたリポジトリそのものの悪意**: dev server を起動する以上、そのコードは利用者権限で動きます。対策は README の「信頼できるリポジトリだけを開く」です。
- **Fetch Metadata 非対応ブラウザからの `<img>` GET**: 応答は読めず、git status が走るだけです。
- **対象 dev server のポートへの直接アクセス**: プロキシを通らないため、対象フレームワーク自身の Host 検査に依存します。
- **Vite 経由で、重複した Content-Type 行の 2 行目以降が落ちること**: ブラウザの fetch は重複値を 1 行に結合するので、この入力はブラウザから作れません。
- **`UIM_HOST` による LAN 公開**: サポート対象外です。認証と TLS はありません。

## 見直す条件

次のいずれかを変えたら、この文書と `tests/acceptance/` を更新します。

- API の公開範囲(bind アドレス、認証の追加)
- プレビュープロキシの経路
- 子プロセスの起動方法
- Anthropic への送信内容
