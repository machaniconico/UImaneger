# UImaneger — 仕様 (MVP)

ローカルで動く「リアルタイムプレビュー × 自然言語UI編集」アプリ。
bolt.new のローカル版 + プレビュー上で要素を選んで部分編集。

## 目的 / コア体験

1. 既存プロジェクト(ローカルパス or GitHub URL)を開く
2. 対象の dev server を子プロセスで起動し iframe にプレビュー
3. プレビュー上の要素をクリック → 対応するソース位置(file:line)を特定
4. 選択した要素について自然言語で指示 → Claude が該当ファイルを部分編集
5. 保存 → HMR で即時反映

## 設計原則: あらゆる言語/FWに対応 (3層 + プロキシ注入)

クリックしたDOM要素 → ソース位置への逆引きはFW依存。これを単一手法でやらず、
「プレビュー注入の普遍化」+「ソース解決の3層プラガブル化」で言語非依存にする。

### プレビュー注入 = HTTPプロキシ方式 (言語非依存の要)
- 対象を **そのプロジェクト自身の serve コマンド** で起動
  (`npm run dev` / `rails s` / `php -S` / `python manage.py runserver` / `go run` …、自動検出 or 手動設定)
- 対象の HTTP を UImaneger プロキシが中継し、**全 HTML レスポンスに inspector `<script>` を注入**
  (WebSocket/HMR も upgrade 透過)
- iframe はプロキシのポートを指す
- → HTML を返すサーバなら **バックエンド言語を問わない**

### ソース解決 = 3層 (プラガブル SourceAdapter)
| 層 | 手法 | 範囲 | 精度 |
|---|---|---|---|
| A 精密アダプタ | React=`_debugSource` / Vue / Svelte / Angular | 既知FW | file:line:col |
| B 普遍フォールバック | 選択要素の特徴(text/class/id/attr/DOMパス)を LLM+ripgrep でリポジトリ検索 | あらゆる言語 | 候補→確定 |
| C 即時ビジュアル | 色/サイズ/余白は注入CSSで即反映→確定時にソース永続化 | 全部 | 見た目は即時 |

`SourceAdapter { detect(page): boolean; resolve(domDescriptor): {file,line?,col?,confidence} }`
未知FWは自動で層B(普遍フォールバック)へ。

## 対象スコープ (MVP)

- 第一級サポート: Vite + React (層A 精密) + 任意の HTML を返すサーバ (層B 普遍)
- 層B により Vue/Svelte/Rails/Django/Laravel/Go/素HTML も「特徴検索」で編集可能
- MVP外: 複数プロジェクト同時、層Cの双方向同期、本番ビルド済みSPAの完全対応

## アーキテクチャ

```
[ブラウザ: エディタUI (Vite+React+Tailwind, :5173)]
   ├─ ProjectBar : プロジェクトを開く/clone, dev server 起動/停止
   ├─ Preview    : iframe(対象dev server) + inspector bridge(postMessage)
   └─ Chat       : 選択要素 + 自然言語指示 → 編集

        │ /api/* (proxy)
        ▼
[ローカルサーバ: Hono (@hono/node-server, :5174)]
   ├─ /api/project  : open(path) / clone(repo) / start / stop / status
   ├─ /api/files    : read / write / list
   ├─ /api/edit     : 自然言語編集 (SourceResolver → Claude API)
   └─ /api/git      : status / commit / branch / push (gh)

[プロキシ (:6100+, http-proxy)]  ← iframe はここを指す
   対象 serve コマンドの出力を中継 + HTML に inspector 注入 + ws(HMR) 透過

[対象プロジェクト dev server (:任意)]  ← npm run dev / rails s / php -S / ...
```

主要モジュール:
- server/lib/runner.ts   : 対象の serve コマンド検出 & 子プロセス起動/停止
- server/lib/proxy.ts    : HTTP 中継 + inspector 注入 + ws upgrade
- server/lib/resolver.ts : SourceResolver (層A採用 / 層B ripgrep+LLM)
- server/lib/claude.ts   : Claude API クライアント
- server/inspector-client.js : 対象ページに注入される選択スクリプト

## クリック→選択 (inspector, プロキシ注入)

- プロキシが対象の全 HTML レスポンスの `</body>` 直前に inspector スクリプトを注入
  (対象プロジェクトのソースは一切変更しない)。
- inspector はホバーで要素を枠表示、クリックで **DOM ディスクリプタ** を収集:
  ```
  {
    tag, id, classes, attrs, textSnippet, domPath (nth-child パス),
    rect, source?: { fileName, lineNumber, columnNumber }  // 層A が取れた場合のみ
  }
  ```
  React 等が居れば fiber を辿って `_debugSource` を `source` に詰める(層A)。
- `window.parent.postMessage({ type:'uim:select', payload }, '*')` で親へ送信。
- 親→iframe へは選択モードのトグルやCSSプレビュー注入(層C)を postMessage で送る。

## ソース解決 (server: SourceResolver)

入力 = DOM ディスクリプタ。
1. `payload.source` があればそれを採用(層A, confidence=high)。
2. 無ければ層B: `textSnippet` / 一意な `id`・`class` を ripgrep でプロジェクト全文検索し、
   候補(file:line)を収集 → Claude(haiku)で最尤を選定 or 複数候補を返す。
3. 出力: `{ file, line?, col?, confidence, candidates? }`

## 自然言語編集フロー (/api/edit)

入力: `{ descriptor, instruction }`
処理:
1. SourceResolver で `descriptor` → `{ file, line }` を解決(層A/B)。
2. サーバが `file` を読む(プロジェクトルート内のみ許可)。
3. Claude(claude-opus-4-8) に「該当要素(line付近 / 特徴一致箇所)を指示通り編集。
   ファイル全体を返す」→ 書き戻し。
   - MVP: 全文返却で書き戻し(差分適用の堅牢性優先)。
4. 対象の HMR / リロードで反映。
5. レスポンス: `{ ok, file, summary, confidence }`(confidence 低時は候補を提示し確認)。

将来: 複数ファイル編集、diff プレビュー&承認、undo/redo(git stash)、層C双方向同期。

## API キー

- `.env` に `ANTHROPIC_API_KEY` を置く(ユーザーが用意)。`.env.example` 参照。
- サーバ起動時に未設定なら /api/edit は 400 と案内を返す。

## 受け入れ基準 (MVP done)

- [ ] `npm run dev` でエディタUI(:5173)とサーバ(:5174)が両方起動
- [ ] ローカルの Vite+React プロジェクトのパスを入力 → dev server 起動 → iframe に表示
- [ ] プレビュー上で要素をクリック → 親UIに file:line が表示される
- [ ] Chat に「この見出しを赤く大きく」等を入力 → 該当ファイルが書き換わり HMR で反映
- [ ] GitHub URL を入力 → clone → 同じフローが動く
- [ ] APIキー未設定時に分かりやすいエラー

## 将来拡張 (MVP外, メモ)

- 要素クリックでなく範囲選択/複数選択
- diff 承認UI と undo
- Vue/Svelte 対応(各 dev tools の source map)
- コンポーネントツリー表示
- スタイルの直接編集(数値スライダ)とコード反映の双方向
