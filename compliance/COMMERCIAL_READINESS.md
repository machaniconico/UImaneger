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
- SAST: semgrep 1.168.0(`p/javascript` `p/typescript` `p/secrets` `p/nodejsscan`)を 2026-11-27 に実行。5 件中 2 件(一時ディレクトリ名の非暗号乱数)を修正、3 件は誤検知(固定 regex、テスト用ダミーキー)
- 外部サービス記録: `THIRD_PARTY_SERVICES.md`
- 現在の対応範囲と未検証 runtime: `../README.md` と `../SPEC.md`

## Open blockers

| Gate | 状態 | 完了に必要な証跡 |
|---|---|---|
| 製品の権利 | BLOCKED | repository の製品 license、著作権者、販売主体の確定 |
| OSS / assets | HUMAN-REVIEW | npm 依存の台帳と許可リスト検査は自動化済み。`standardwebhooks@1.0.0` は npm に LICENSE 本文が無く upstream 参照。font・icon・asset の確認と法務の最終承認が残る |
| Anthropic terms / privacy | HUMAN-REVIEW | `THIRD_PARTY_SERVICES.md` の release blockers 解消 |
| Security | BLOCKED | 依存 scan は CI 化済み、SAST は手動実行済み。残りは secret scan と SAST の CI 化、配布 artifact scan、脅威モデルの release 証跡 |
| Browser E2E | PARTIAL | `npm run e2e`(Playwright 1.65.0 / Chromium、偽 Anthropic API、同梱 Vite+React サンプルの一時複製)で open・select・proposal・apply・undo と、別タブでの状態保持つき HMR を検証。2026-11-27 にローカル(WSL2/Node 22)で連続 PASS。残り: CI 上の初回 PASS 記録、Windows/macOS、Firefox/WebKit、実 API キーでの確認 |
| Runtime matrix | BLOCKED | claim する OS と主要 framework/runtime の実プロセス検証 |
| Distribution | BLOCKED | installer/package、署名、artifact hash、更新、rollback の確認 |
| Operations | BLOCKED | support、脆弱性受付、incident response、data deletion の窓口と手順 |
| Legal / store | HUMAN-REVIEW | 対象国、販売経路、価格、返金、規約、表示義務の専門家確認 |

## Release rule

直近 commit から作成した配布 artifact に対して、上記の権利・規約・security blocker がすべて解消され、tool version 付き検査結果、SBOM、license 台帳、artifact hash、署名、例外承認が紐付いた場合だけ `COMMERCIAL-READINESS: PASS` とする。
