import { describe, expect, it } from "vitest";
import { stripCodeFence } from "./claude.ts";

describe("stripCodeFence", () => {
  it("extracts code from a fenced tsx block", () => {
    expect(stripCodeFence("```tsx\nconst x = <Button />;\n```")).toBe(
      "const x = <Button />;"
    );
  });

  it("returns the whole trimmed text when no fence is present", () => {
    expect(stripCodeFence("  plain text\nwith details  ")).toBe(
      "plain text\nwith details"
    );
  });

  it("extracts the first fenced block after leading prose", () => {
    expect(
      stripCodeFence(
        "Here is the component:\n```tsx\nexport function App() {}\n```\nThanks"
      )
    ).toBe("export function App() {}");
  });

  it("extracts inner code (preserving nested fences) without leaking the outer fence markers", () => {
    const inner = [
      "const markdown = `",
      "```",
      "this fence is part of the generated code, not the answer terminator",
      "```",
      "`;",
      `const retained = "${"x".repeat(260)}";`,
    ].join("\n");
    const nested = ["```tsx", inner, "```"].join("\n");

    const out = stripCodeFence(nested);
    // 入れ子フェンスを内包した中身を返し、外側フェンス記号は決して残さない
    expect(out).toBe(inner);
    expect(out.startsWith("```")).toBe(false);
  });

  it("returns clean code (never fence markers) for a long preamble + short code block", () => {
    const input =
      "Sure! ".repeat(45) +
      "\n```tsx\nexport const A = () => <div>hi</div>;\n```";
    const out = stripCodeFence(input);
    expect(out).toBe("export const A = () => <div>hi</div>;");
    expect(out.startsWith("```")).toBe(false);
    expect(out.includes("Sure!")).toBe(false);
  });

  it("handles a closing fence without a trailing newline", () => {
    expect(stripCodeFence("```ts\nconst ok = true;\n```")).toBe(
      "const ok = true;"
    );
  });
});
