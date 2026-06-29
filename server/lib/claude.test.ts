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

  it("falls back to the original text when an inner fence would truncate most content", () => {
    const nested = [
      "```tsx",
      "const markdown = `",
      "```",
      "this fence is part of the generated code, not the answer terminator",
      "```",
      "`;",
      `const retained = "${"x".repeat(260)}";`,
      "```",
    ].join("\n");

    expect(stripCodeFence(nested)).toBe(nested);
  });

  it("handles a closing fence without a trailing newline", () => {
    expect(stripCodeFence("```ts\nconst ok = true;\n```")).toBe(
      "const ok = true;"
    );
  });
});
