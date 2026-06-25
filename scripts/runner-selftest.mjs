// scripts/runner-selftest.mjs
// US-003: detectRunnerFromFacts / extractPort の単体テスト (純粋関数)。
// 実行: node scripts/runner-selftest.mjs
// ※ Node 22.6+ の型除去で .ts を直接 import できる前提。このプロジェクトは Node 24。

import {
  detectRunnerFromFacts,
  extractPort,
  PORT_PATTERNS,
} from "../server/lib/runner.ts";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(typeof detail === "string" ? `${name} — ${detail}` : name);
    if (typeof detail !== "string") {
      console.error(`FAIL: ${name}`);
    } else {
      console.error(`FAIL: ${name} — ${detail}`);
    }
  }
}

function eq(name, actual, expected) {
  const cond = JSON.stringify(actual) === JSON.stringify(expected);
  ok(
    name,
    cond,
    cond ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// --- helpers: ファクトリ ---
function emptyFacts(overrides = {}) {
  return {
    hasPackageJson: false,
    dependencies: {},
    devDependencies: {},
    scripts: {},
    devScript: "",
    startScript: "",
    pkgName: undefined,
    hasGemfile: false,
    hasRailsBin: false,
    hasManagePy: false,
    hasGoMod: false,
    hasComposerJson: false,
    hasArtisan: false,
    hasPublicIndexPhp: false,
    hasIndexPhp: false,
    hasPublicDir: false,
    hasIndexHtml: false,
    hasSvelteConfig: false,
    hasAstroConfig: false,
    hasNuxtConfig: false,
    hasVueConfig: false,
    hasRemixConfig: false,
    ...overrides,
  };
}

function nodeFacts(deps = {}, scripts = {}, extra = {}) {
  return emptyFacts({
    hasPackageJson: true,
    dependencies: deps,
    scripts,
    devScript: scripts.dev ?? "",
    startScript: scripts.start ?? "",
    ...extra,
  });
}

// =========================================================================
// 1. detectRunnerFromFacts: 各FW判別
// =========================================================================

// Vite (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ vite: "^5.0.0" }, {}),
    5173
  );
  eq("Vite via dep", plan.framework, "Vite");
  eq("Vite knownPort", plan.knownPort, true);
  ok("Vite args has --port", plan.args.includes(String(5173)));
  ok("Vite uses strictPort", plan.args.includes("--strictPort"));
}

// Vite (dev script ヒューリスティック)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, { dev: "vite" }),
    5173
  );
  eq("Vite via devScript", plan.framework, "Vite");
}

// Next.js (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ next: "^14.0.0" }, {}),
    3000
  );
  eq("Next.js via dep", plan.framework, "Next.js");
  eq("Next.js knownPort", plan.knownPort, true);
  ok("Next.js uses -p", plan.args.includes("-p"));
}

// Next.js (dev script)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, { dev: "next dev" }),
    3000
  );
  eq("Next.js via devScript", plan.framework, "Next.js");
}

// Create React App
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ "react-scripts": "5.0.1" }, {}),
    3000
  );
  eq("CRA framework", plan.framework, "Create React App");
  eq("CRA knownPort", plan.knownPort, true);
  ok("CRA sets PORT env", plan.env?.PORT === "3000");
  ok("CRA disables browser", plan.env?.BROWSER === "none");
}

// Angular
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ "@angular/cli": "^17.0.0" }, {}),
    4200
  );
  eq("Angular framework", plan.framework, "Angular");
  eq("Angular knownPort", plan.knownPort, true);
  ok("Angular uses ng serve", plan.args[0] === "ng");
}

// Vue CLI (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ "@vue/cli-service": "^5.0.0" }, {}),
    8080
  );
  eq("Vue CLI via dep", plan.framework, "Vue CLI");
  eq("Vue CLI knownPort", plan.knownPort, true);
}

// Vue CLI (config ヒューリスティック)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, {}, { hasVueConfig: true }),
    8080
  );
  eq("Vue CLI via config", plan.framework, "Vue CLI");
}

// SvelteKit (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ "@sveltejs/kit": "^2.0.0" }, {}),
    5173
  );
  eq("SvelteKit via dep", plan.framework, "SvelteKit");
  eq("SvelteKit knownPort", plan.knownPort, true);
}

// SvelteKit (config)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, {}, { hasSvelteConfig: true }),
    5173
  );
  eq("SvelteKit via config", plan.framework, "SvelteKit");
}

// Astro (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ astro: "^4.0.0" }, {}),
    4321
  );
  eq("Astro via dep", plan.framework, "Astro");
  eq("Astro knownPort", plan.knownPort, true);
}

// Astro (config)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, {}, { hasAstroConfig: true }),
    4321
  );
  eq("Astro via config", plan.framework, "Astro");
}

// Nuxt (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ nuxt: "^3.0.0" }, {}),
    3000
  );
  eq("Nuxt via dep", plan.framework, "Nuxt");
  eq("Nuxt knownPort", plan.knownPort, true);
}

// Nuxt (config)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, {}, { hasNuxtConfig: true }),
    3000
  );
  eq("Nuxt via config", plan.framework, "Nuxt");
}

// Remix (依存)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({ remix: "^2.0.0" }, {}),
    3000
  );
  eq("Remix via dep", plan.framework, "Remix");
  eq("Remix knownPort", plan.knownPort, true);
}

// Remix (config)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, {}, { hasRemixConfig: true }),
    3000
  );
  eq("Remix via config", plan.framework, "Remix");
}

// Rails
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasGemfile: true, hasRailsBin: true }),
    3000
  );
  eq("Rails framework", plan.framework, "Rails");
  eq("Rails knownPort", plan.knownPort, true);
  ok("Rails uses bin/rails", plan.command === "bin/rails");
  ok("Rails server -p", plan.args.includes("-p"));
}

// Django
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasManagePy: true }),
    8000
  );
  eq("Django framework", plan.framework, "Django");
  eq("Django knownPort", plan.knownPort, true);
  ok("Django runserver", plan.args.includes("runserver"));
}

// Go (PORT env, ポート固定不可)
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasGoMod: true }),
    8080
  );
  eq("Go framework", plan.framework, "Go");
  eq("Go not knownPort", plan.knownPort, false);
  ok("Go sets PORT env", plan.env?.PORT === "8080");
  ok("Go uses go run", plan.args[0] === "run");
}

// Laravel (artisan serve)
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasArtisan: true }),
    8000
  );
  eq("Laravel framework", plan.framework, "Laravel");
  eq("Laravel knownPort", plan.knownPort, true);
  ok("Laravel uses artisan serve", plan.args.includes("artisan"));
}

// PHP (composer.json + public/ で php -S)
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasComposerJson: true, hasPublicDir: true }),
    8000
  );
  eq("PHP framework", plan.framework, "PHP");
  eq("PHP knownPort", plan.knownPort, true);
  ok("PHP uses -S", plan.args.includes("-S"));
  ok("PHP docroot public", plan.args.includes("public"));
}

// PHP (素の index.php, public なし)
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasIndexPhp: true }),
    8000
  );
  eq("PHP plain framework", plan.framework, "PHP");
  ok("PHP plain docroot .", plan.args.includes("."));
}

// 静的サイト (index.html)
{
  const plan = detectRunnerFromFacts(
    emptyFacts({ hasIndexHtml: true }),
    5000
  );
  eq("Static framework", plan.framework, "Static");
  eq("Static knownPort", plan.knownPort, true);
  ok("Static uses serve", plan.args.includes("serve"));
}

// 汎用 node (dev script のみ, ポート固定不可)
{
  const plan = detectRunnerFromFacts(
    nodeFacts({}, { dev: "node server.js" }, { pkgName: "myapp" }),
    3000
  );
  ok("Generic node framework includes pkgName", plan.framework.includes("myapp"));
  eq("Generic node not knownPort", plan.knownPort, false);
  ok("Generic node runs dev script", plan.args[0] === "run" && plan.args[1] === "dev");
  ok("Generic node sets PORT env", plan.env?.PORT === "3000");
}

// =========================================================================
// 2. 検出不能 → 明確な Error
// =========================================================================

{
  let threw = false;
  let msg = "";
  try {
    detectRunnerFromFacts(emptyFacts(), 3000);
  } catch (e) {
    threw = true;
    msg = String(e.message ?? e);
  }
  ok("Unknown throws Error", threw);
  ok("Unknown error mentions runCommand", /runCommand/.test(msg));
}

// =========================================================================
// 3. extractPort: stdout から複数フォーマットでポート検出
// =========================================================================

function portEq(name, line, expected) {
  const got = extractPort(line);
  ok(
    name,
    got === expected,
    `expected ${expected}, got ${got} (line: ${JSON.stringify(line)})`
  );
}

// Vite / Next / Nuxt / SvelteKit: "Local:   http://localhost:5173/"
portEq("Vite Local line", "  ➜  Local:   http://localhost:5173/", 5173);
// Next.js
portEq("Next Local line", "  - Local:        http://localhost:3000", 3000);
// CRA
portEq(
  "CRA Local line",
  "  Local:            http://localhost:3000",
  3000
);
// Astro
portEq("Astro Local line", "  ┃  Local    http://localhost:4321/", 4321);
// Nuxt
portEq("Nuxt Local line", "  ➜  Local:    http://localhost:3000/", 3000);

// Rails Puma: "Listening on http://0.0.0.0:3000"
portEq("Rails Puma line", "* Listening on http://0.0.0.0:3000", 3000);
// Django
portEq(
  "Django line",
  "Starting development server at http://127.0.0.1:8000/",
  8000
);
// Laravel artisan (新)
portEq(
  "Laravel serve line",
  "   INFO  Server running on [http://127.0.0.1:8000].",
  8000
);
// Laravel artisan (旧)
portEq(
  "Laravel old line",
  "Starting Laravel development server: http://127.0.0.1:8000",
  8000
);
// php -S
portEq(
  "php -S line",
  "PHP 8.2 Development Server (http://localhost:8000) started",
  8000
);

// Angular: "listening on localhost:4200"
portEq(
  "Angular listening line",
  "** Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/ **",
  4200
);
// Go: "listening on :8080"
portEq("Go listening colon line", "listening on :8080", 8080);
// Go: "listening on port 3000"
portEq("Go listening port line", "listening on port 3000", 3000);
// Go: "Server running on port 8080"
portEq("Go Server running port line", "Server running on port 8080", 8080);
// "Server running at http://localhost:9000"
portEq("Server running at line", "Server running at http://localhost:9000", 9000);
// "started on http://localhost:7000"
portEq("started on line", "started on http://localhost:7000", 7000);

// ヒットしない行
portEq("no port line", "Compiling... done", null);
portEq("empty line", "", null);
// ポート範囲外の数字 (65536) は弾く
portEq("port out of range", "http://localhost:99999/", null);

// 複数候補がある場合は最初のパターン(より具体的)が優先
{
  // "Local: http://localhost:3000  also listening on :4000"
  // URL パターンが先に 3000 を拾うべき
  const got = extractPort("Local: http://localhost:3000 also listening on :4000");
  ok("first pattern wins", got === 3000, `got ${got}`);
}

// =========================================================================
// 4. PORT_PATTERNS は複数パターンを保持
// =========================================================================
ok("PORT_PATTERNS has multiple patterns", PORT_PATTERNS.length >= 4);

// =========================================================================
// 結果表示
// =========================================================================
console.log(`\n=== runner-selftest: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
