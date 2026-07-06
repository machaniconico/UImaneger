import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  __resolverTestHooks,
  isGenericClass,
  buildTerms,
  splitWords,
  termWeight,
  scoreCandidate,
  hasRareTerm,
  resolveSource,
} from "./resolver.ts";
import type { DomDescriptor } from "./types.ts";
import type { ScoredTerm, TermKind } from "./resolver.ts";

function mkD(over: Partial<DomDescriptor> = {}): DomDescriptor {
  return {
    tag: "button",
    id: undefined,
    classes: [],
    attrs: {},
    domPath: "html>body>button",
    ...over,
  };
}

function st(term: string, kind: TermKind, hits: number): ScoredTerm {
  return { term, kind, hits };
}

const tempRoots: string[] = [];

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uim-resolver-"));
  tempRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = join(root, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return root;
}

afterEach(async () => {
  __resolverTestHooks.forceRgUsable(null);
  __resolverTestHooks.resetNodeGrepTreeWalks();
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("isGenericClass — Tailwind 汎用クラスの除外", () => {
  it("flags common Tailwind utilities as generic", () => {
    for (const c of ["flex", "grid", "block", "hidden", "w-full", "h-full"]) {
      expect(isGenericClass(c)).toBe(true);
    }
  });

  it("flags property+scale utilities (px-4, text-sm, rounded-lg)", () => {
    expect(isGenericClass("px-4")).toBe(true);
    expect(isGenericClass("text-sm")).toBe(true);
    expect(isGenericClass("rounded-lg")).toBe(true);
    expect(isGenericClass("gap-4")).toBe(true);
  });

  it("flags variant-prefixed utilities (hover:, md:)", () => {
    expect(isGenericClass("hover:bg-blue-500")).toBe(true);
    expect(isGenericClass("md:flex-row")).toBe(true);
  });

  it("does NOT flag project-specific / PascalCase classes", () => {
    expect(isGenericClass("UserCard")).toBe(false);
    expect(isGenericClass("btn-primary")).toBe(false);
    expect(isGenericClass("data-testid")).toBe(false);
    expect(isGenericClass("Product-3")).toBe(false);
  });
});

describe("termWeight — 希少性 (hits が少ないほど重い)", () => {
  it("returns the base weight when hits=0 (未集計)", () => {
    expect(termWeight("textFull", 0)).toBeCloseTo(100);
    expect(termWeight("id", 0)).toBeCloseTo(80);
    expect(termWeight("classGeneric", 0)).toBeCloseTo(2);
  });

  it("amplifies rare signals (hits <= 1 → 1.5x)", () => {
    expect(termWeight("textFull", 1)).toBeCloseTo(100 * 1.5);
    expect(termWeight("id", 1)).toBeCloseTo(80 * 1.5);
  });

  it("attenuates noisy signals (hits > 30 → 0.4x)", () => {
    expect(termWeight("textFull", 100)).toBeCloseTo(100 * 0.4);
    expect(termWeight("classGeneric", 500)).toBeCloseTo(2 * 0.4);
  });

  it("keeps generic classes low even when rare (classGeneric base=2)", () => {
    // 汎用クラスは希少でも 2*1.5=3 にしかならない → textFull(100) より圧倒的に低い
    expect(termWeight("classGeneric", 1)).toBeLessThan(termWeight("textFull", 100));
  });
});

describe("scoreCandidate — 汎用クラス低スコア / 希少 term 高スコア", () => {
  it("a single rare id outscored many generic classes", () => {
    const manyGenerics = [
      st("flex", "classGeneric", 500),
      st("grid", "classGeneric", 300),
      st("px-4", "classGeneric", 200),
    ];
    const oneRareId = [st("login-btn", "id", 1)];
    expect(scoreCandidate(oneRareId)).toBeGreaterThan(scoreCandidate(manyGenerics));
  });

  it("multi-term match (textFull + id + specific class) beats single textFull", () => {
    const multi = [
      st("Sign in now", "textFull", 2),
      st("login-btn", "id", 1),
      st("UserCard", "classSpecific", 1),
    ];
    const single = [st("Sign in now", "textFull", 2)];
    expect(scoreCandidate(multi)).toBeGreaterThan(scoreCandidate(single));
  });

  it("rare term beats frequent term of the same kind", () => {
    const rare = [st("login-btn", "id", 1)]; // 80 * 1.5 = 120
    const frequent = [st("header", "id", 100)]; // 80 * 0.4 = 32
    expect(scoreCandidate(rare)).toBeGreaterThan(scoreCandidate(frequent));
  });
});

describe("hasRareTerm", () => {
  it("treats low-hit textFull / id / textPartial as rare", () => {
    expect(hasRareTerm([st("x", "textFull", 1)])).toBe(true);
    expect(hasRareTerm([st("x", "id", 3)])).toBe(true);
    expect(hasRareTerm([st("x", "textPartial", 5)])).toBe(true);
  });

  it("does NOT treat generic classes as rare even at 1 hit", () => {
    expect(hasRareTerm([st("flex", "classGeneric", 1)])).toBe(false);
  });

  it("does NOT treat high-hit text as rare", () => {
    expect(hasRareTerm([st("x", "textFull", 200)])).toBe(false);
  });
});

describe("buildTerms — CJK / 通常テキストの基本ケース", () => {
  it("emits textFull for a normal ASCII snippet (>=4 chars)", () => {
    const terms = buildTerms(mkD({ textSnippet: "Sign in now" }));
    const full = terms.find((t) => t.kind === "textFull");
    expect(full).toBeDefined();
    expect(full?.term).toBe("Sign in now");
  });

  it("emits textFull for a short CJK snippet (CJK is allowed < 4 chars)", () => {
    // "通知" is 2 chars but CJK → still long enough? buildTerms checks .trim().length >= 4
    // for textFull regardless of CJK. So a 2-char CJK snippet would NOT become textFull.
    // Use a 4-char CJK snippet to confirm it becomes textFull.
    const terms = buildTerms(mkD({ textSnippet: "通知設定を開く" }));
    const full = terms.find((t) => t.kind === "textFull");
    expect(full).toBeDefined();
    expect(full?.term).toBe("通知設定を開く");
  });

  it("classifies Tailwind classes as classGeneric and specific classes as classSpecific", () => {
    const terms = buildTerms(
      mkD({ classes: ["flex", "px-4", "UserCard", "btn-primary"] })
    );
    const byTerm = new Map(terms.map((t) => [t.term, t.kind]));
    expect(byTerm.get("flex")).toBe("classGeneric");
    expect(byTerm.get("px-4")).toBe("classGeneric");
    expect(byTerm.get("UserCard")).toBe("classSpecific");
    expect(byTerm.get("btn-primary")).toBe("classSpecific");
  });

  it("does not emit textFull when snippet is too short (<4 chars)", () => {
    const terms = buildTerms(mkD({ textSnippet: "go" }));
    expect(terms.some((t) => t.kind === "textFull")).toBe(false);
  });

  it("puts textFull before id before classes (order preserved)", () => {
    const terms = buildTerms(
      mkD({
        textSnippet: "Sign in now",
        id: "login-btn",
        classes: ["flex", "UserCard"],
      })
    );
    const kinds = terms.map((t) => t.kind);
    expect(kinds).toEqual([
      "textFull",
      "id",
      "classGeneric",
      "classSpecific",
    ]);
  });
});

describe("splitWords — CJK は短くても残す", () => {
  it("keeps CJK tokens even when 1 char (non-ASCII rule)", () => {
    // "通知 on/off" → 通知 (non-ASCII, len 2 → kept), on (len 2 → filtered), off (len 3 → kept)
    const words = splitWords("通知 on/off");
    expect(words).toContain("通知");
    expect(words).toContain("off");
    expect(words).not.toContain("on"); // too short for ASCII rule
  });

  it("filters ASCII tokens shorter than 3 chars", () => {
    expect(splitWords("a b cd")).toEqual([]);
  });

  it("deduplicates while preserving order", () => {
    const words = splitWords("hello hello world world");
    expect(words).toEqual(["hello", "world"]);
  });

  it("returns empty array for empty input", () => {
    expect(splitWords("")).toEqual([]);
  });
});

describe("resolveSource Layer-B integration", () => {
  it("locates a source line by textSnippet when source is omitted", async () => {
    const root = await fixture({
      "src/TextHit.tsx": [
        "export function TextHit() {",
        "  return <button>Launch Control Panel</button>;",
        "}",
      ].join("\n"),
      "src/Other.tsx": [
        "export function Other() {",
        "  return <button>Settings</button>;",
        "}",
      ].join("\n"),
    });

    const result = await resolveSource(
      root,
      mkD({ textSnippet: "Launch Control Panel" })
    );

    expect(result.file).toBe(join(root, "src/TextHit.tsx"));
    expect(result.line).toBe(2);
  });

  it("locates a short CJK label by textSnippet over generic classes", async () => {
    const root = await fixture({
      "src/AOther.tsx": [
        "export function AOther() {",
        '  return <button className="flex grid">送信</button>;',
        "}",
      ].join("\n"),
      "src/ZSave.tsx": [
        "export function ZSave() {",
        "  const ready = true;",
        '  return <button className="flex grid">保存</button>;',
        "}",
      ].join("\n"),
    });

    const result = await resolveSource(
      root,
      mkD({ textSnippet: "保存", classes: ["flex", "grid"] })
    );

    expect(result.file).toBe(join(root, "src/ZSave.tsx"));
    expect(result.line).toBe(3);
  });

  it("locates a 3-char ASCII label by textSnippet in the no-ripgrep path", async () => {
    const root = await fixture({
      "src/AOther.tsx": [
        "export function AOther() {",
        '  return <button className="flex grid">Pay</button>;',
        "}",
      ].join("\n"),
      "src/ZBuy.tsx": [
        "export function ZBuy() {",
        "  const ready = true;",
        '  return <button className="flex grid">Buy</button>;',
        "}",
      ].join("\n"),
    });
    __resolverTestHooks.forceRgUsable(false);

    const result = await resolveSource(
      root,
      mkD({ textSnippet: "Buy", classes: ["flex", "grid"] })
    );

    expect(result.file).toBe(join(root, "src/ZBuy.tsx"));
    expect(result.line).toBe(3);
  });

  it("locates a source line by id when source is omitted", async () => {
    const root = await fixture({
      "src/IdHit.tsx": [
        "export function IdHit() {",
        '  return <button id="billing-submit">Pay now</button>;',
        "}",
      ].join("\n"),
      "src/Other.tsx": [
        "export function Other() {",
        '  return <button id="billing-cancel">Cancel</button>;',
        "}",
      ].join("\n"),
    });

    const result = await resolveSource(root, mkD({ id: "billing-submit" }));

    expect(result.file).toBe(join(root, "src/IdHit.tsx"));
    expect(result.line).toBe(2);
  });

  it("locates a source line by a specific class when source is omitted", async () => {
    const root = await fixture({
      "src/ClassHit.tsx": [
        "export function ClassHit() {",
        '  return <section className="ProductHeroCta px-4">Buy</section>;',
        "}",
      ].join("\n"),
      "src/Other.tsx": [
        "export function Other() {",
        '  return <section className="ProductHeroShell px-4">Read</section>;',
        "}",
      ].join("\n"),
    });

    const result = await resolveSource(root, mkD({ tag: "section", classes: ["ProductHeroCta"] }));

    expect(result.file).toBe(join(root, "src/ClassHit.tsx"));
    expect(result.line).toBe(2);
  });

  it("locates a source line for a dash-leading class term", async () => {
    const root = await fixture({
      "src/DashHit.tsx": [
        "export function DashHit() {",
        '  return <div className="-mt-4">Discount</div>;',
        "}",
      ].join("\n"),
    });

    const result = await resolveSource(root, mkD({ tag: "div", classes: ["-mt-4"] }));

    expect(result.file).toBe(join(root, "src/DashHit.tsx"));
    expect(result.line).toBe(2);
  });

  it("uses one project walk in the no-ripgrep path while preserving aggregate matches", async () => {
    const root = await fixture({
      "Fixture.tsx": [
        "export function Fixture() {",
        '  return <button id="save-order" className="CheckoutSaveCta">Save order</button>;',
        '  return <button className="CheckoutSaveCta">Secondary</button>;',
        "}",
      ].join("\n"),
    });
    __resolverTestHooks.forceRgUsable(false);

    const { candidates, termHits } = await __resolverTestHooks.collectCandidates(
      root,
      mkD({
        textSnippet: "Save order",
        id: "save-order",
        classes: ["CheckoutSaveCta"],
      })
    );

    expect(__resolverTestHooks.getNodeGrepTreeWalks()).toBe(1);
    expect(termHits.get("Save order")).toBe(1);
    expect(termHits.get("save-order")).toBe(1);
    expect(termHits.get("CheckoutSaveCta")).toBe(2);
    expect(candidates[0]?.file).toBe(join(root, "Fixture.tsx"));
    expect(candidates[0]?.line).toBe(2);
    expect(candidates[0]?.matched.map((m) => [m.term, m.kind, m.hits])).toEqual([
      ["Save order", "textFull", 1],
      ["save-order", "id", 1],
      ["CheckoutSaveCta", "classSpecific", 2],
    ]);
    expect(candidates[1]?.line).toBe(3);
    expect(candidates[1]?.matched.map((m) => [m.term, m.kind, m.hits])).toEqual([
      ["CheckoutSaveCta", "classSpecific", 2],
    ]);
  });
});
