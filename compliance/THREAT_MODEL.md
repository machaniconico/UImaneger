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
3. **開いたリポジトリのコード**: clone したプロジェクトの install 設定と dev server。Static モード(`server/static-server.mjs`)ではリポジトリのコードはサーバ側で実行されず、ブラウザ内でだけ動く。
4. **Anthropic API**: 編集指示と対象ファイルの送信先(`THIRD_PARTY_SERVICES.md`)。

## 脅威と対策

| ID | 脅威 | 対策 | 証跡 |
|---|---|---|---|
| T1 | 別 origin のページが単純リクエスト(`text/plain`、`no-cors`)でコントロール API を叩き、clone 後の自動起動で任意コード実行、または `/api/files/write` で任意ファイルを書き換える(CSRF) | Origin を UI の origin(scheme・host・port)と完全一致で照合。状態を変えるメソッドは `application/json` を必須にし(415)、プリフライトを強制する。CORS ヘッダは一切返さない | `tests/acceptance/security-origin.test.ts`、`tests/acceptance/app-wiring.test.ts` |
| T2 | Origin の付かない `<img src=/api/git/status>` などの GET で、git の実行を誘発する | Fetch Metadata の `Sec-Fetch-Site` が `same-site`・`cross-site`・未知値なら 403 | `rejects_same_site_and_cross_site_get_without_origin`、`blocks_img_triggered_git_status` |
| T3 | DNS rebinding で外部サイトがコントロール API に到達する | Host を `localhost`・`127.0.0.1`・`[::1]` に限定(`*.localhost` と不正な authority は拒否)。dev 時は Vite の `changeOrigin: false` により、元の Host が API に届く | `allows_loopback_host_any_port`、`rejects_non_loopback_and_subdomain_host`、`server/vite-config.test.ts` |
| T4 | DNS rebinding でプレビュープロキシ経由の対象 dev server を読み、ソースや HMR WebSocket に到達する | プロキシは HTTP・upgrade とも、upstream に接続する前に Host と Origin を検査する。拒否経路のソケットエラーでプロセスが落ちないようにする | `tests/acceptance/proxy-host-origin.test.ts`、`server/lib/proxy.test.ts` |
| T5 | clone したプロジェクトのコードが、継承された `ANTHROPIC_API_KEY` を読み取って外部に送る | 子プロセスの env は `buildChildEnv` だけで作る。`ANTHROPIC_*`・`UIM_*`・`.env` 由来のキーを除去する | `tests/acceptance/child-env.test.ts`、`server/lib/child-env.test.ts` |
| T6 | 編集・適用・undo でプロジェクト root の外に書き込む(`..`、symlink、絶対パス)、または書き込みで権限やリンクを壊す | `inRoot` が root とファイルの双方を realpath で解決し、外を拒否する。保護パス(T13)も拒否する。書き込みは realpath 先への rename による原子的置換で、symlink はリンクを保ってリンク先を更新する。一時ファイルは排他作成・0600 で作り、既存ファイルの `mode & 0o777` を umask に依存せず引き継ぐ(新規は `0666 & ~umask`) | `server/routes/api.test.ts` の traversal・symlink 脱出・候補ファイル範囲外の各テスト、`tests/acceptance/atomic-write-mode.test.ts` |
| T7 | clone URL によるコマンドや引数のインジェクション(先頭の `-`、`ext::`、`file:`) | HTTPS・SSH・scp 形式のみ受け付け、`--` で区切る。`protocol.ext.allow=never` と `GIT_ALLOW_PROTOCOL` を設定する | `server/routes/api.test.ts` |
| T8 | install 時にリポジトリのコードが走る | lifecycle script を無効化し、pnpm は `--ignore-pnpmfile` も付ける。Yarn 2 以降の `yarnPath` や plugin は止められないので、README に明記する | `server/lib/package-manager.test.ts`、README「セキュリティ」 |
| T9 | 一時ディレクトリの事前作成や名前の予測による乗っ取り | `mkdtempSync` で排他的に作成する | `server/lib/worktree.test.ts` |
| T10 | API キーがログやレスポンスに出る | `sanitizeForLog` で伏せ字にし、レスポンスにはキーを含めない | `server/routes/api.test.ts` |
| T11 | 依存パッケージの既知脆弱性、コードに混入した秘密、危険なコードパターン | CI の `audit`(moderate 以上)、`secret-scan`(gitleaks、git 履歴全体)、`sast`(semgrep)の各 job | `.github/workflows/ci.yml` |
| T12 | Static 配信で、`\`・`%2F`・`//`・ドットセグメント・二重エンコード・大小文字・symlink などの別表記により `.env`・`.git`・`node_modules` を読む | request-target を 1 回だけデコードし、`\` と NUL を含めば 404。正規化後のセグメントと、realpath 後の root 相対パスの両方で隠し名(`.well-known` を除く)と `node_modules` を大小文字無視で拒否する。Windows では末尾のドット・空白と `:`(ADS)も拒否する | `tests/acceptance/static-hidden-paths.test.ts` |
| T13 | プレビュー内のスクリプトが source ヒントを偽装し、`.git`・`.env`・`node_modules` の内容を Claude に送らせる、または書き換えさせる(`.git` への書き込みは、このツール自身が実行する git によってコード実行に昇格する) | `server/lib/path-policy.ts` が root 相対パスを字面と realpath の両方で見て、`.git`・`node_modules`・先頭ドットのセグメントを大小文字無視で拒否する(403)。edit 系・files 系の全経路と、apply・undo・redo の実行時に判定する。層 A は保護パスを指すヒントを無視して層 B に進む | `tests/acceptance/protected-paths.test.ts` |
| T14 | 親リポジトリのサブディレクトリを開いた時に、範囲外の変更やステージ済みの変更までコミットする | root がリポジトリのサブディレクトリなら、git の status・add・ステージ判定・commit すべてに pathspec `-- .`(cwd=root)を付ける。root がリポジトリ直下なら pathspec を付けない(マージ完了コミットを妨げないため)。サブディレクトリでマージ・cherry-pick・revert・rebase の途中なら、`git add` より前に 409 で止める | `tests/acceptance/git-scope.test.ts` |
| T15 | 別ポートの localhost ページがプレビューを iframe に埋め込み、inspector の選択結果を受け取る | CSP `frame-ancestors` を `'self'` と UI の origin(dev は clientPort、production は serverPort)だけにする。inspector は配信時に埋め込まれた同じ origin の一覧と完全一致した親だけを信頼し、最初に信頼した origin に固定する。`/__uim/inspector.js` は `cache-control: no-store` | `tests/acceptance/preview-parent-origin.test.ts`、`server/inspector-client.test.ts` |

## 受容したリスク(非目標)

- **同一 OS ユーザーのローカルプロセス**: 利用者と同じ権限を持つ時点で防御対象外です。トークン方式もこの相手には効きません。
- **開いたリポジトリそのものの悪意**: dev server を起動する以上、そのコードは利用者権限で動きます。Django ではプロジェクト直下の `.venv` / `venv` にある Python 実行ファイルを優先して起動するため、リポジトリに同梱されたバイナリも同じ扱いになります。対策は README の「信頼できるリポジトリだけを開く」です。
- **Fetch Metadata 非対応ブラウザからの `<img>` GET**: 応答は読めず、git status が走るだけです。
- **対象 dev server のポートへの直接アクセス**: プロキシを通らないため、対象フレームワーク自身の Host 検査に依存します。
- **Vite 経由で、重複した Content-Type 行の 2 行目以降が落ちること**: ブラウザの fetch は重複値を 1 行に結合するので、この入力はブラウザから作れません。
- **`UIM_HOST` による LAN 公開**: サポート対象外です。認証と TLS はありません。
- **Windows の ACL**: 書き込み時の一時ファイルは元ファイルの ACL を継承しません。mode の保持も POSIX だけです。
- **特殊ビット**: setuid・setgid・sticky は書き込み後に保持しません(`mode & 0o777` のみ)。
- **所有者**: 書き込みは一時ファイルの rename なので、元ファイルの uid・gid は引き継がず、サーバを動かすユーザーの所有になります。
- **隠しでない設定ファイル**: `package.json`・`vite.config.ts` などは編集対象のままです。これらの変更は次の dev server 起動時に実行されます。
- **Git hooks**: commit 時にはリポジトリの hooks が実行されます(`.git` への書き込み経路は T13 で塞いでいます)。
- **検査から書き込み・読み取りまでの競合(TOCTOU)**: 保護パス・root 内の検査と、書き込み(rename)・静的配信・ソース読み取りの間に、親ディレクトリやリンク先を並行して差し替えられる窓が残ります。rename 直前の再検査、検査した実体の fd での配信、`O_NONBLOCK` での open で窓は狭めていますが、ゼロにはできません。差し替えにはプロジェクト内に書き込めるローカルプロセスが必要で、上の「同一 OS ユーザーのローカルプロセス」に含まれます。
- **umask 測定用の一時ファイル**: 新規ファイルを書くとき、最終 mode を決めるために同じディレクトリに `.uim-umask-<uuid>` を一瞬作って消します。dev server のファイル監視が反応することがあり、強制終了時には空のファイルが残り得ます。

## 見直す条件

次のいずれかを変えたら、この文書と `tests/acceptance/` を更新します。

- API の公開範囲(bind アドレス、認証の追加)
- プレビュープロキシの経路
- 子プロセスの起動方法
- Anthropic への送信内容
