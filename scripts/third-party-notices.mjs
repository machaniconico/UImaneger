// 配布物に含まれる第三者パッケージのライセンス台帳を生成・検査する。
//
// 対象 = package-lock.json の本番依存(dev ではない entry)
//      + クライアントバンドルに埋め込まれる devDependency の閉包(BUNDLED_ROOTS)。
// 使い方:
//   node scripts/third-party-notices.mjs          compliance/THIRD_PARTY_NOTICES.md を書き換える
//   node scripts/third-party-notices.mjs --check  生成結果と既存ファイルが一致し、全ライセンスが許可済みか検査する
//
// OS/CPU 限定の optional パッケージ(esbuild のプラットフォーム別バイナリ等)は
// インストールされる環境が変わるため、本文を埋め込まず lockfile の SPDX 識別子だけを記載する。
// これにより生成結果がプラットフォームに依存しない。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT = "compliance/THIRD_PARTY_NOTICES.md";
// Vite が dist/ に同梱する devDependency。クライアントの import を変えたらここも更新する。
const BUNDLED_ROOTS = ["react", "react-dom", "tailwindcss"];
// 販売配布で追加確認なしに使えるライセンス。これ以外は検査で失敗させ、人の判断を求める。
const ALLOWED = new Set([
  "MIT",
  "ISC",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Unlicense",
  "CC0-1.0",
  "BlueOak-1.0.0",
]);
// npm パッケージに LICENSE 本文が同梱されていないことを確認済みの entry。
// 本文は upstream リポジトリを参照する。新しい欠落は検査で失敗させ、確認後にここへ追加する。
const MISSING_TEXT_REVIEWED = {
  "standardwebhooks@1.0.0": "https://github.com/standard-webhooks/standard-webhooks",
};
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const packages = lock.packages ?? {};

function nameOf(key) {
  return key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
}

// Node の解決規則で、key の位置から依存 name の lock entry を探す。
function resolveKey(fromKey, name) {
  let base = fromKey;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const idx = base.lastIndexOf("/node_modules/");
    base = idx === -1 ? "" : base.slice(0, idx);
  }
}

const selected = new Set();
for (const [key, entry] of Object.entries(packages)) {
  if (key && !entry.dev && !entry.link) selected.add(key);
}
const stack = BUNDLED_ROOTS.map((name) => {
  const key = resolveKey("", name);
  if (!key) throw new Error(`bundled root ${name} is not in package-lock.json`);
  return key;
});
while (stack.length) {
  const key = stack.pop();
  // 本番依存として既に選ばれた entry は、その依存も本番依存なので辿り直さない。
  if (selected.has(key)) continue;
  selected.add(key);
  const deps = { ...packages[key].dependencies, ...packages[key].optionalDependencies };
  for (const dep of Object.keys(deps)) {
    const depKey = resolveKey(key, dep);
    if (depKey && !selected.has(depKey)) stack.push(depKey);
  }
}

function licenseText(key) {
  if (!existsSync(key)) return null;
  const files = readdirSync(key).filter((f) => LICENSE_FILE.test(f)).sort();
  if (!files.length) return null;
  return files
    .map((f) => readFileSync(join(key, f), "utf8").replace(/\r\n/g, "\n").trimEnd())
    .join("\n\n");
}

const rows = [...selected]
  .map((key) => {
    const entry = packages[key];
    return {
      key,
      name: nameOf(key),
      version: entry.version,
      license: entry.license ?? "UNKNOWN",
      platform: Boolean(entry.os || entry.cpu),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

// 同名同版が複数位置にあれば 1 件にまとめる。
const unique = [];
for (const row of rows) {
  const prev = unique[unique.length - 1];
  if (prev && prev.name === row.name && prev.version === row.version) continue;
  unique.push(row);
}

const problems = [];
const lines = [
  "# Third-party notices",
  "",
  "このファイルは `node scripts/third-party-notices.mjs` が package-lock.json と node_modules から生成します。手で編集しないでください。",
  "",
  `対象: 本番依存と、クライアントバンドルに含まれる ${BUNDLED_ROOTS.map((r) => `\`${r}\``).join("、")} の依存閉包。`,
  "",
  "| Package | Version | License |",
  "|---|---|---|",
  ...unique.map((r) => `| ${r.name} | ${r.version} | ${r.license}${r.platform ? " (platform-specific)" : ""} |`),
  "",
];
for (const row of unique) {
  if (!ALLOWED.has(row.license)) problems.push(`${row.name}@${row.version}: license "${row.license}" is not in the allowlist`);
  lines.push(`## ${row.name}@${row.version}`, "", `License: ${row.license}`, "");
  if (row.platform) {
    lines.push("プラットフォーム別バイナリ。ライセンス本文は同じ配布元の主パッケージを参照してください。", "");
    continue;
  }
  const text = licenseText(row.key);
  const reviewed = MISSING_TEXT_REVIEWED[`${row.name}@${row.version}`];
  if (text === null && reviewed) {
    lines.push(`npm パッケージに本文が含まれていません。upstream: ${reviewed}`, "");
  } else if (text === null) {
    problems.push(`${row.name}@${row.version}: no LICENSE file found in ${row.key}`);
    lines.push("(ライセンス本文がパッケージに含まれていません)", "");
  } else {
    lines.push("```text", text, "```", "");
  }
}
const output = lines.join("\n");

// クライアントの本番コードが import する bare package は BUNDLED_ROOTS か本番依存に含まれていなければならない。
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]
  );
}
const IMPORT = /(?:from\s*|import\s*\(?\s*|@import\s+)["']([^"'./][^"']*)["']/g;
const rootNames = new Set([...BUNDLED_ROOTS, ...Object.keys(lock.packages[""]?.dependencies ?? {})]);
for (const file of walk("src")) {
  if (!/\.(tsx?|jsx?|css)$/.test(file) || /\.test\.[jt]sx?$/.test(file)) continue;
  for (const m of readFileSync(file, "utf8").matchAll(IMPORT)) {
    const spec = m[1];
    const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!rootNames.has(pkg)) problems.push(`${file} imports "${spec}" but ${pkg} is not in BUNDLED_ROOTS or dependencies`);
  }
}

if (process.argv.includes("--check")) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (current !== output) problems.push(`${OUTPUT} is out of date; run npm run notices`);
} else {
  writeFileSync(OUTPUT, output);
  console.log(`notices: wrote ${unique.length} packages to ${OUTPUT}`);
}
if (problems.length) {
  console.error("\nthird-party notices check failed:");
  for (const p of problems) console.error(`- ${p}`);
  process.exit(1);
}
if (process.argv.includes("--check")) console.log(`notices: ok (${unique.length} packages)`);
