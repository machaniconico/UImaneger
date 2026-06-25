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

## 開発

```bash
npm run typecheck
node scripts/runner-selftest.mjs   # FW検出ロジックの自己テスト
```
