# UImaneger

ローカルで動く **リアルタイムプレビュー × 自然言語UI編集** アプリ。
bolt.new のローカル版 + プレビュー上で要素を選んで自然言語でその場編集。

## できること

- 既存プロジェクト(ローカルパス or GitHub URL)を開く
- 3ペイン構成: **左=GUI操作 / 中央=編集前(HEAD) / 右=変更後(ライブ)**
- プレビュー上の要素をクリック → 対応ソースを特定 → 自然言語で指示 → その場で反映
- 編集は **差分プレビュー → 承認/却下/undo** のフロー
- **あらゆる言語/FW対応**(3層解決): React は精密(`_debugSource`)、その他は ripgrep+LLM の特徴検索で言語非依存に特定

## 技術構成

- UIシェル: Vite + React + TypeScript + Tailwind
- ローカルサーバ: Hono (`server/`)
- プレビュー: 対象アプリを自身の serve コマンドで起動 → http-proxy で中継し inspector を注入
- 編集前/変更後: git worktree で HEAD を別配信(git無しは degrade)
- LLM: Claude API

詳細は [SPEC.md](./SPEC.md) を参照。

## 使い方

```bash
npm install
cp .env.example .env   # ANTHROPIC_API_KEY を設定
npm run dev            # エディタUI(:5173) + サーバ(:5174)
```

ブラウザで http://localhost:5173 を開き、ローカルパスか GitHub URL を入力。

### すぐ試す (同梱サンプル)

お試し用の React アプリを同梱しています。プロジェクト入力欄に次のパスを入れて「開く」:

```
<このリポジトリの絶対パス>/examples/sample-app
```

中央に「編集前」、右に「変更後」が表示されます。「要素を選択」→ 見出しやボタンをクリック →
「この見出しを大きく赤く」などと入力すると、差分プレビュー → 承認で右側に即反映されます。
(編集機能には `.env` の `ANTHROPIC_API_KEY` が必要です)

## セキュリティ

ローカル単一ユーザー向けツールとして、安全側の既定で動作します。

- コントロールAPI(ファイル読み書き等)は **`127.0.0.1` のみにバインド**(プレビュープロキシと同様)。
- `/api/*` は **Origin/Host allowlist** で保護し、`localhost` / `127.0.0.1` / `::1` / `*.localhost` 以外からのリクエストを 403 で拒否(LAN・CSRF・DNS-rebind 対策)。
- LANからアクセスしたい場合のみ `UIM_HOST=0.0.0.0 npm run dev` で明示的にバインド先を変更できます(自己責任。信頼できるネットワークでのみ)。

## 開発

```bash
npm run typecheck   # 型チェック
npm test            # selftest(runner/resolver) + vitest(ユニット/統合)
npm run build       # 本番ビルド
```

- テスト: `scripts/*-selftest.mjs`(FW検出/ソース解決の純関数)+ `server/**/*.test.ts`・`src/**/*.test.tsx`(vitest)。編集パイプライン(`/api/edit`→apply/undo)は Claude 呼び出しを mock した統合テストで検証。
- CI: `.github/workflows/ci.yml` が push/PR で `npm ci → typecheck → test → build` を実行(job 名 `test`)。Node 24 固定(`.ts` 直接 import の型除去が Node 22.6+ 前提)。

> 実APIキーを使ったエンドツーエンドの編集確認(ブラウザで要素選択→指示→反映)は、`.env` に `ANTHROPIC_API_KEY` を設定して手元で行ってください(CIでは mock のため未検証)。
