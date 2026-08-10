# Commercial readiness

評価日: 2026-08-08

現在判定: `COMMERCIAL-READINESS: BLOCKED`

テスト成功は技術品質の証拠ですが、権利、privacy、配布、運用を含む販売可否の承認ではありません。

## Evidence available

- exact dependency versions と lockfile 整合を `npm run policy` で検査
- TypeScript、selftest、Vitest、production build を `npm run verify` で検査
- CycloneDX SBOM: `sbom.cdx.json`
- 外部サービス記録: `THIRD_PARTY_SERVICES.md`
- 現在の対応範囲と未検証 runtime: `../README.md` と `../SPEC.md`

## Open blockers

| Gate | 状態 | 完了に必要な証跡 |
|---|---|---|
| 製品の権利 | BLOCKED | repository の製品 license、著作権者、販売主体の確定 |
| OSS / assets | BLOCKED | 直接・推移依存、font、icon、asset の license 確認と `THIRD_PARTY_NOTICES` |
| Anthropic terms / privacy | HUMAN-REVIEW | `THIRD_PARTY_SERVICES.md` の release blockers 解消 |
| Security | BLOCKED | secret scan、SAST、依存 scan、配布 artifact scan、脅威モデルの release 証跡 |
| Browser E2E | BLOCKED | 実ブラウザで open、select、proposal、apply、undo、HMR を検証 |
| Runtime matrix | BLOCKED | claim する OS と主要 framework/runtime の実プロセス検証 |
| Distribution | BLOCKED | installer/package、署名、artifact hash、更新、rollback の確認 |
| Operations | BLOCKED | support、脆弱性受付、incident response、data deletion の窓口と手順 |
| Legal / store | HUMAN-REVIEW | 対象国、販売経路、価格、返金、規約、表示義務の専門家確認 |

## Release rule

直近 commit から作成した配布 artifact に対して、上記の権利・規約・security blocker がすべて解消され、tool version 付き検査結果、SBOM、license 台帳、artifact hash、署名、例外承認が紐付いた場合だけ `COMMERCIAL-READINESS: PASS` とする。
