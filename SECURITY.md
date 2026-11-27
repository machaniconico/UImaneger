# Security policy

## 脆弱性の報告

脆弱性は **公開 issue に書かず**、GitHub の非公開報告で送ってください。

1. リポジトリの [Security タブ](https://github.com/machaniconico/UImaneger/security) を開く
2. 「Report a vulnerability」を選ぶ
3. 再現手順、影響、対象 commit または版、想定する攻撃者(別 origin の Web ページ、同一ネットワーク、開いたリポジトリなど)を書く

報告の内容は、修正を公開するまで報告者とメンテナだけが見られます。

## 対象

| 対象 | 状態 |
|---|---|
| `main` ブランチの最新 commit | 対象 |
| 開発ブランチ | ベストエフォート |
| 過去の commit・fork | 対象外 |

現時点では版番号付きのリリースはありません(`package.json` は `0.1.0`、`private: true`)。

## 対象外

次は [脅威モデル](./compliance/THREAT_MODEL.md) で受容したリスクで、脆弱性としては扱いません。

- 利用者と同じ OS ユーザー権限で動くローカルプロセスによる操作
- 利用者が開いたリポジトリそのものが悪意を持つ場合(dev server の起動は、そのコードの実行を意味します)
- `UIM_HOST` で LAN に公開した構成(サポート対象外)
- 対象 dev server のポートへの直接アクセス(UImaneger のプレビュープロキシを経由しないもの)

## 対応の流れ

1. 受領を Security タブ上で返信する
2. 再現を確認し、深刻度を判定する
3. 修正と回帰テストを用意し、GitHub Security Advisory として公開する

応答期限などのサポート条件は、販売主体と運用体制が決まった時点でこの文書に追記します(`compliance/COMMERCIAL_READINESS.md` の Operations ゲート)。
