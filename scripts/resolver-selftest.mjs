// scripts/resolver-selftest.mjs
// US-008: resolver 層B 精度向上 純関数検査 (isGenericClass / buildTerms / splitWords /
//        scoreCandidate / termWeight / hasRareTerm)。
// 実行: node scripts/resolver-selftest.mjs
// ※ Node 22.6+ の型除去で .ts を直接 import できる前提。本プロジェクトは Node 24。

import {
  isGenericClass,
  buildTerms,
  splitWords,
  scoreCandidate,
  termWeight,
  hasRareTerm,
} from "../server/lib/resolver.ts";

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(typeof detail === "string" ? `${name} — ${detail}` : name);
    console.error(
      `FAIL: ${name}${typeof detail === "string" ? ` — ${detail}` : ""}`
    );
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
function closeTo(name, actual, expected, eps = 1e-6) {
  const cond = Math.abs(actual - expected) <= eps;
  ok(
    name,
    cond,
    cond ? "" : `expected ${expected}, got ${actual}`
  );
}

function mkD(over = {}) {
  return {
    tag: "button",
    id: undefined,
    classes: [],
    attrs: {},
    domPath: "html>body>button",
    ...over,
  };
}

// =========================================================================
// 1. isGenericClass: Tailwind 汎用クラスを検出
// =========================================================================
ok("generic flex", isGenericClass("flex"));
ok("generic grid", isGenericClass("grid"));
ok("generic px-4", isGenericClass("px-4"));
ok("generic text-sm", isGenericClass("text-sm"));
ok("generic w-full", isGenericClass("w-full"));
ok("generic rounded-lg", isGenericClass("rounded-lg"));
ok("generic hover variants", isGenericClass("hover:bg-blue-500"));
ok("generic md variants", isGenericClass("md:flex-row"));
ok("generic space-x-2", isGenericClass("space-x-2"));
ok("generic gap-4", isGenericClass("gap-4"));
ok("generic z-50", isGenericClass("z-50"));
ok("generic -translate-y-1", isGenericClass("-translate-y-1"));

// 逆に固有クラスは generic 判定されないこと
ok("specific card class not generic", !isGenericClass("UserCard"));
ok("specific data-* not generic", !isGenericClass("data-testid"));
ok("specific btn-primary not generic", !isGenericClass("btn-primary"));
ok("specific my-component not generic", !isGenericClass("my-component"));
ok("specific numeric suffix not generic", !isGenericClass("Product-3"));
ok("short excluded too small", !isGenericClass("go")); // 長すぎる短すぎる境界は種別次第だが go は non-generic

// =========================================================================
// 2. splitWords: textSnippet を語単位に分割 (フォールバック用)
// =========================================================================
eq("splitWords simple", splitWords("Login User"), ["Login", "User"]);
eq("splitWords punctuation", splitWords("Hello, world!"), ["Hello", "world"]);
eq("splitWords too short filtered", splitWords("a b cd"), []);
eq("splitWords dedup", splitWords("go go go"), ["go"].filter((w) => w.length >= 3)); // "go" < 3 → 空配列
eq("splitWords empty", splitWords(""), []);
eq("splitWords keep japanese-ish", splitWords("通知 on/off"), ["通知", "off"]);

// =========================================================================
// 3. buildTerms: kind と順序
// =========================================================================
{
  const d = mkD({
    id: "login-btn",
    textSnippet: "Sign in now",
    classes: ["flex", "px-4", "UserCard"],
  });
  const terms = buildTerms(d);
  // 順序: textSnippet(全文) → id → classes(generic/specific 含む)
  eq("buildTerms order 0 textFull", terms[0].kind, "textFull");
  eq("buildTerms order 0 term", terms[0].term, "Sign in now");
  eq("buildTerms order 1 id", terms[1].kind, "id");
  eq("buildTerms order 2 flex generic", terms[2].kind, "classGeneric");
  eq("buildTerms order 3 px-4 generic", terms[3].kind, "classGeneric");
  eq("buildTerms order 4 UserCard specific", terms[4].kind, "classSpecific");
}
{
  // textSnippet が短すぎると textFull は作られない (全文は希少すぎて hit しない)
  const d = mkD({ textSnippet: "go", classes: ["flex"] });
  const terms = buildTerms(d);
  ok("buildTerms no short text term", terms.every((t) => t.kind !== "textFull"));
}

// =========================================================================
// 4. termWeight: kind の基本重みと rarity の倍率
// =========================================================================
closeTo("w textFull at 1 hit", termWeight("textFull", 1), 100 * 1.5);
closeTo("w textFull at 5 hit", termWeight("textFull", 5), 100 * 1.0);
closeTo("w textFull at 100 hit", termWeight("textFull", 100), 100 * 0.4);
closeTo("w id at 3 hit", termWeight("id", 3), 80 * 1.25);
closeTo("w textPartial at 0 hit", termWeight("textPartial", 0), 40);
closeTo("w classSpecific at 11 hit", termWeight("classSpecific", 11), 30 * 0.7);
closeTo("w classGeneric at 200 hit", termWeight("classGeneric", 200), 2 * 0.4);
// generic は希少でも基本重みが低い (ノイズ対策)
closeTo("w classGeneric at 1 hit", termWeight("classGeneric", 1), 2 * 1.5);

// =========================================================================
// 5. scoreCandidate: 複数 term 同時マッチが加算で最尤に立つ
// =========================================================================
{
  // A: id(1 hit, 希少) + textSnippet 全文(2 hit) + 固有クラス UserCard(1 hit)
  const a = [
    { term: "Sign in now", kind: "textFull", hits: 2 },
    { term: "login-btn", kind: "id", hits: 1 },
    { term: "UserCard", kind: "classSpecific", hits: 1 },
  ];
  // B: textSnippet 全文だけ (2 hit)
  const b = [{ term: "Sign in now", kind: "textFull", hits: 2 }];
  // C: 汎用クラス多数 (高ヒット)
  const c = [
    { term: "flex", kind: "classGeneric", hits: 500 },
    { term: "px-4", kind: "classGeneric", hits: 300 },
  ];

  const sa = scoreCandidate(a);
  const sb = scoreCandidate(b);
  const sc = scoreCandidate(c);
  ok("A beats B (multi term match)", sa > sb);
  ok("B beats C (rare signals beat many generics)", sb > sc);
  ok("C is near zero relative to A", sc < sa / 20);
}
{
  // 希少 term なしでクラスだけ (generic だくさんでも score は伸びない)
  const onlyGeneric = [
    { term: "flex", kind: "classGeneric", hits: 200 },
    { term: "grid", kind: "classGeneric", hits: 200 },
  ];
  const oneRare = [{ term: "login-btn", kind: "id", hits: 1 }];
  ok("one rare id beats many generics",
    scoreCandidate(oneRare) > scoreCandidate(onlyGeneric));
}

// =========================================================================
// 6. hasRareTerm
// =========================================================================
ok("rare textFull", hasRareTerm([{ term: "x", kind: "textFull", hits: 1 }]));
ok("rare id", hasRareTerm([{ term: "x", kind: "id", hits: 3 }]));
ok("not rare generic", !hasRareTerm([{ term: "x", kind: "classGeneric", hits: 1 }]));
ok("not rare high-match text", !hasRareTerm([{ term: "x", kind: "textFull", hits: 200 }]));

// =========================================================================
// 結果表示
// =========================================================================
console.log(`\n=== resolver-selftest: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  console.error("\nFailures:");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}