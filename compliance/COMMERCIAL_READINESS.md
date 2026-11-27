# Commercial readiness

評価日: 2026-08-08

現在判定: `COMMERCIAL-READINESS: BLOCKED`

テスト成功は技術品質の証拠ですが、権利、privacy、配布、運用を含む販売可否の承認ではありません。

## Evidence available

- exact dependency versions と lockfile 整合を `npm run policy` で検査
- TypeScript、selftest、Vitest、production build を `npm run verify` で検査
- CycloneDX SBOM: `sbom.cdx.json`(`npm run sbom`。失敗時は既存ファイルを変更しない)
- 依存 scan: `npm run audit`(moderate 以上で失敗)。CI の `audit` job で毎 push 実行。2026-11-27 時点 0 件
- 第三者ライセンス台帳: `THIRD_PARTY_NOTICES.md`(`npm run notices` で生成、`verify` で鮮度と許可ライセンスを検査。対象は本番依存とクライアントバンドルの React/Tailwind 閉包。2026-11-27 時点 42 件すべて MIT/Unlicense)
- SAST: semgrep 1.168.0(`p/javascript` `p/typescript` `p/secrets` `p/nodejsscan`)を CI の `sast` job で毎 push 実行(検出で失敗)。2026-11-27 時点 0 件。初回 5 件のうち 2 件(一時ディレクトリ名の非暗号乱数)を修正、4 箇所の誤検知は理由付き `nosemgrep` で抑止
- Secret scan: gitleaks 8.30.1 で git 履歴全体を CI の `secret-scan` job で検査。許可は `.gitleaks.toml` の RFC 6455 サンプルキーのみ。2026-11-27 時点 37 commits で 0 件
- 脅威モデル: `THREAT_MODEL.md`(信頼境界、T1〜T11 の対策と証跡テスト、受容リスク)
- 外部サービス記録: `THIRD_PARTY_SERVICES.md`
- 現在の対応範囲と未検証 runtime: `../README.md` と `../SPEC.md`

## Open blockers

| Gate | 状態 | 完了に必要な証跡 |
|---|---|---|
| 製品の権利 | BLOCKED | repository の製品 license、著作権者、販売主体の確定 |
| OSS / assets | HUMAN-REVIEW | npm 依存の台帳と許可リスト検査は自動化済み。`standardwebhooks@1.0.0` は npm に LICENSE 本文が無く upstream 参照。font・icon・asset の確認と法務の最終承認が残る |
| Anthropic terms / privacy | HUMAN-REVIEW | `THIRD_PARTY_SERVICES.md` の release blockers 解消 |
| Security | BLOCKED | 2026-11-27 の脅威レビューで出た CSRF(別ポート localhost からの単純リクエスト)、プレビュープロキシの DNS rebinding、子プロセスへの API キー継承を修正済み(受け入れテスト `tests/acceptance/` 41 件、異系統レビュー 2 系統 APPROVE、最終受け入れ PASS)。依存 scan・SAST・secret scan は CI 化済み。脅威モデルは `THREAT_MODEL.md` に記録。残りは配布 artifact scan、第三者による侵入試験(CI の audit・secret-scan・sast は run 46016436860 で PASS) |
| Browser E2E | PARTIAL | `npm run e2e`(Playwright 1.65.0 / Chromium、偽 Anthropic API、同梱 Vite+React サンプルの一時複製)で open・select・proposal・apply・undo と、別タブでの状態保持つき HMR を検証。2026-11-27 にローカル(WSL2/Node 22)と GitHub Actions ubuntu-latest で PASS(run 46016436860、commit `469ae1c`)。Firefox もローカルで PASS。CI は Ubuntu で Chromium/Firefox/WebKit、Windows で Chromium/Firefox を実行。残り: macOS、実 API キーでの確認 |
| Runtime matrix | PARTIAL | 2026-11-27 に WSL2 / Node 22（一部は一時 SDK を使用）で 19 PASS、2 SKIP、0 FAIL。Rails と Phoenix は fixture あり・実プロセス未実行。GitHub Actions(run 46016436860、commit `469ae1c`)で Ubuntu は 19 構成(node・python・php・go・java・dotnet を必須化)、Windows は Node 系 12 構成が PASS。残りは Rails/Phoenix、Windows の非 Node runtime、macOS |
| Distribution | BLOCKED | installer/package、署名、artifact hash、更新、rollback の確認 |
| Operations | BLOCKED | support、脆弱性受付、incident response、data deletion の窓口と手順 |
| Legal / store | HUMAN-REVIEW | 対象国、販売経路、価格、返金、規約、表示義務の専門家確認 |

## Release rule

直近 commit から作成した配布 artifact に対して、上記の権利・規約・security blocker がすべて解消され、tool version 付き検査結果、SBOM、license 台帳、artifact hash、署名、例外承認が紐付いた場合だけ `COMMERCIAL-READINESS: PASS` とする。
