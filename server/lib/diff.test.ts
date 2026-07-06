import { describe, it, expect } from "vitest";
import { diffLines, createUnifiedDiff } from "./diff.ts";

describe("diffLines", () => {
  it("returns all-context lines for identical content", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
    ]);
  });

  it("returns empty array for two empty strings", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("treats trailing newline-only difference as no change at line level", () => {
    // splitLines strips trailing empty line, so "a\nb" === "a\nb\n"
    expect(diffLines("a\nb", "a\nb\n")).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
    ]);
  });

  it("detects pure addition (append only)", () => {
    const out = diffLines("a\nb", "a\nb\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  it("detects pure removal (delete only)", () => {
    const out = diffLines("a\nb\nc", "a\nb");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "remove", text: "c" },
    ]);
  });

  it("detects mixed change (modify a line)", () => {
    const out = diffLines("a\nb\nc", "a\nx\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "x" },
      { type: "context", text: "c" },
    ]);
  });

  it("detects single-line change", () => {
    const out = diffLines("hello", "world");
    expect(out).toEqual([
      { type: "remove", text: "hello" },
      { type: "add", text: "world" },
    ]);
  });

  it("emits only add lines when original is empty", () => {
    const out = diffLines("", "a\nb");
    expect(out).toEqual([
      { type: "add", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("emits only remove lines when proposed is empty", () => {
    const out = diffLines("a\nb", "");
    expect(out).toEqual([
      { type: "remove", text: "a" },
      { type: "remove", text: "b" },
    ]);
  });

  it("normalizes CRLF to LF before comparing", () => {
    const out = diffLines("a\r\nb\r\n", "a\r\nb\r\nc");
    expect(out).toEqual([
      { type: "context", text: "a" },
      { type: "context", text: "b" },
      { type: "add", text: "c" },
    ]);
  });

  it("falls back to a bounded-memory full replacement for very large inputs", () => {
    const original = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join("\n");
    const proposed = Array.from({ length: 1500 }, (_, i) => `new ${i}`).join("\n");
    const out = diffLines(original, proposed);
    expect(out).toHaveLength(3000);
    expect(out[0]).toEqual({ type: "remove", text: "old 0" });
    expect(out[1499]).toEqual({ type: "remove", text: "old 1499" });
    expect(out[1500]).toEqual({ type: "add", text: "new 0" });
  });

  it("falls back to a full replacement when one side has too many lines", () => {
    const original = [
      "shared anchor",
      ...Array.from({ length: 20_000 }, (_, i) => `old ${i}`),
    ].join("\n");
    const out = diffLines(original, "shared anchor");

    expect(out).toHaveLength(20_002);
    expect(out[0]).toEqual({ type: "remove", text: "shared anchor" });
    expect(out[20_001]).toEqual({ type: "add", text: "shared anchor" });
  });
});

describe("createUnifiedDiff", () => {
  it("returns empty string when there is no change", () => {
    expect(createUnifiedDiff("a\nb", "a\nb")).toBe("");
  });

  it("returns empty string for identical empty inputs", () => {
    expect(createUnifiedDiff("", "")).toBe("");
  });

  it("emits default header when relFile is omitted", () => {
    const out = createUnifiedDiff("a\nb", "a\nb\nc");
    expect(out.startsWith("--- original\n+++ proposed\n")).toBe(true);
  });

  it("emits a/ b/ header when relFile is provided", () => {
    const out = createUnifiedDiff("a\nb", "a\nb\nc", "file.txt");
    expect(out.startsWith("--- a/file.txt\n+++ b/file.txt\n")).toBe(true);
  });

  it("contains a hunk header with @@ markers and old/new ranges", () => {
    const out = createUnifiedDiff("a\nb", "a\nb\nc", "f.txt");
    // Hunk header line begins with @@ -<old> +<new> @@
    const hunkLine = out.split("\n").find((l) => l.startsWith("@@"));
    expect(hunkLine).toBeDefined();
    expect(hunkLine).toMatch(/^@@ -\S+ \+\S+ @@$/);
  });

  it("includes +/- body lines for an added line", () => {
    // 純粋な追加を検証するため両側とも末尾改行付き入力を使う
    // (末尾改行なし入力だと最終行 b の終端子が変化し GNU 準拠で -b/+b になる。
    //  そのケースは別テスト "emits an old-side no-newline marker ..." がカバー)
    const out = createUnifiedDiff("a\nb\n", "a\nb\nc\n", "f.txt");
    const lines = out.split("\n");
    expect(lines.some((l) => l === "+c")).toBe(true);
    expect(lines.some((l) => l === " a")).toBe(true);
    expect(lines.some((l) => l === " b")).toBe(true);
    // No remove lines in a pure addition
    expect(lines.some((l) => l === "-c")).toBe(false);
    expect(lines.some((l) => l === "-b")).toBe(false);
  });

  it("includes - lines for a removed line", () => {
    const out = diffLinesToUnified("a\nb\nc", "a\nb");
    const lines = out.split("\n");
    expect(lines.some((l) => l === "-c")).toBe(true);
    expect(lines.some((l) => l === "+c")).toBe(false);
  });

  it("includes both - and + for a modified line", () => {
    const out = diffLinesToUnified("a\nb\nc", "a\nx\nc");
    const lines = out.split("\n");
    expect(lines.some((l) => l === "-b")).toBe(true);
    expect(lines.some((l) => l === "+x")).toBe(true);
  });

  it("emits '\\ No newline at end of file' marker when proposed has no trailing newline on the last added line", () => {
    // original empty, proposed single line without trailing newline
    const out = createUnifiedDiff("", "solo");
    expect(out).toContain("\\ No newline at end of file");
    expect(out).toContain("+solo");
  });

  it("does not emit no-newline marker when both sides end with newline", () => {
    const out = createUnifiedDiff("a\n", "a\nb\n");
    expect(out).not.toContain("\\ No newline at end of file");
    expect(out).toContain("+b");
  });

  it("emits an old-side no-newline marker when the old final context line gets following new lines", () => {
    const out = createUnifiedDiff("a", "a\nb\n", "f.txt");
    expect(out).toBe(
      [
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1 +1,2 @@",
        "-a",
        "\\ No newline at end of file",
        "+a",
        "+b",
        "",
      ].join("\n")
    );
  });

  it("emits a diff when only the original is missing the final newline", () => {
    const out = createUnifiedDiff("a\nb", "a\nb\n", "f.txt");
    expect(out).toContain("@@ -1,2 +1,2 @@");
    expect(out).toContain("-b\n\\ No newline at end of file\n+b");
  });

  it("emits a diff when only the proposed file is missing the final newline", () => {
    const out = createUnifiedDiff("a\nb\n", "a\nb", "f.txt");
    expect(out).toContain("@@ -1,2 +1,2 @@");
    expect(out).toContain("-b\n+b\n\\ No newline at end of file");
  });

  it("emits a final-line remove/add pair when only its trailing newline status changes in a mixed diff", () => {
    const out = createUnifiedDiff("x\nlast\n", "y\nlast", "f.txt");
    const lines = out.split("\n");
    const removedLast = lines.indexOf("-last");
    const addedLast = lines.indexOf("+last");
    const marker = lines.indexOf("\\ No newline at end of file");

    expect(out).toContain("@@ -1,2 +1,2 @@");
    expect(removedLast).toBeGreaterThan(-1);
    expect(addedLast).toBe(removedLast + 1);
    expect(marker).toBe(addedLast + 1);
  });

  it("starts old range at 1 for a change in the first line", () => {
    const out = createUnifiedDiff("hello", "world", "f.txt");
    const hunkLine = out.split("\n").find((l) => l.startsWith("@@")) ?? "";
    // Old file had 1 line starting at line 1, new file has 1 line starting at line 1
    expect(hunkLine).toBe("@@ -1 +1 @@");
  });
});

function diffLinesToUnified(original: string, proposed: string): string {
  return createUnifiedDiff(original, proposed, "f.txt");
}
