# Third-party services ledger

確認日: 2026-08-08

この台帳は実装と配布判断のための事実記録であり、法的助言ではありません。利用開始時と各 release 前に、対象 plan、model、販売地域を含めて公式文書を再確認します。

## Anthropic API

| 項目 | 記録 |
|---|---|
| Product / SDK | Anthropic API / `@anthropic-ai/sdk` 0.106.0 |
| 用途 | 選択したソースファイルの編集案生成 |
| 送信データ | 対象ファイル全文、編集指示、DOM descriptor、候補位置 |
| Credential | `ANTHROPIC_API_KEY` をローカル server process の環境変数から読む。client bundle へ渡さない |
| 商用利用 | Commercial Terms は API を顧客製品へ組み込む利用を想定している。再販や競合製品用途には制限がある |
| 入出力の権利 | Commercial Terms 上、Customer Content の Input は顧客に留保され、Output は顧客に帰属する。ただし第三者権利や出力の一意性を保証するものではない |
| 学習利用 | Commercial Terms 上、Customer Content をモデル学習へ使わない。明示的な opt-in や feedback は別扱い |
| 保持 | API の Input/Output は通常30日以内に削除される。Usage Policy 違反対応、法令、別契約、Zero Data Retention などの例外がある |
| 料金 / limit | 利用量課金と rate limit は account、plan、model に依存するため、release 時に Console と公式 pricing を確認する |
| 終了時 | API key の失効、環境変数とログの削除、privacy notice と保持記録の更新が必要 |

公式資料:

- Commercial Terms: https://www.anthropic.com/legal/commercial-terms
- Usage Policy: https://www.anthropic.com/legal/aup
- Privacy Center - API data retention: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- Privacy Center - model training: https://privacy.claude.com/en/articles/7996885-how-do-you-use-personal-data-in-model-training
- Pricing: https://www.anthropic.com/pricing

## Release blockers

- 対象法人・販売地域・利用者区分に対する Commercial Terms、Usage Policy、supported regions の責任者確認
- 必要な DPA と controller / processor の役割整理
- ソースコードが外部送信されること、送信項目、目的、保持期間、削除窓口を示す privacy notice と同意設計
- 秘密、個人情報、第三者提供禁止コードを送信しないための運用と technical control
- 出力の人手確認、権利確認、誤編集からの復旧手順
- model / plan ごとの料金上限、rate limit、障害時動作、Zero Data Retention 要否の決定

現在判定: `HUMAN-REVIEW`。上記が未確定のため販売ゲートは `BLOCKED`。
