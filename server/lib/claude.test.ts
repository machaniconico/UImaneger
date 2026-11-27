import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "./env.ts";
import {
  complete,
  getClient,
  hasKey,
  streamComplete,
  stripCodeFence,
  TruncatedError,
} from "./claude.ts";

const anthropicMock = vi.hoisted(() => {
  const create = vi.fn();
  const stream = vi.fn();
  const Anthropic = vi.fn(function Anthropic() {
    return {
      messages: { create, stream },
    };
  });
  return { Anthropic, create, stream };
});

vi.mock("@anthropic-ai/sdk", () => ({
  default: anthropicMock.Anthropic,
}));

const originalAnthropicKey = env.anthropicKey;

type MockMessage = {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string;
};

function message(
  content: MockMessage["content"],
  stop_reason: MockMessage["stop_reason"]
): MockMessage {
  return { content, stop_reason };
}

beforeEach(() => {
  env.anthropicKey = "test-key";
  anthropicMock.Anthropic.mockClear();
  anthropicMock.create.mockReset();
  anthropicMock.stream.mockReset();
});

afterAll(() => {
  env.anthropicKey = originalAnthropicKey;
});

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

  it("preserves tail content after a nested fence near the bottom of a large fenced response", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`);
    lines.splice(
      949,
      0,
      "const script = `",
      "```bash",
      "npm run build",
      "```",
      "`;",
      "const finalSentinel = 'tail must remain';"
    );
    const inner = lines.join("\n");
    const nested = ["```tsx", inner, "```"].join("\n");

    const out = stripCodeFence(nested);

    expect(out).toBe(inner);
    expect(out).toContain("const finalSentinel = 'tail must remain';");
    expect(out).toContain("line 1000");
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

describe("complete", () => {
  it("rejects with TruncatedError when max_tokens stops the response", async () => {
    anthropicMock.create.mockResolvedValue(
      message([{ type: "text", text: "partial" }], "max_tokens")
    );

    await expect(complete("prompt")).rejects.toBeInstanceOf(TruncatedError);
  });

  it("resolves text when the response ends normally", async () => {
    anthropicMock.create.mockResolvedValue(
      message([{ type: "text", text: "complete text" }], "end_turn")
    );

    await expect(complete("prompt")).resolves.toBe("complete text");
  });

  it("resolves partial text for max_tokens when truncation is allowed", async () => {
    anthropicMock.create.mockResolvedValue(
      message([{ type: "text", text: "partial text" }], "max_tokens")
    );

    await expect(
      complete("prompt", { allowTruncated: true })
    ).resolves.toBe("partial text");
  });

  it("falls back to an empty string when no text content block exists", async () => {
    anthropicMock.create.mockResolvedValue(
      message([{ type: "tool_use" }], "end_turn")
    );

    await expect(complete("prompt")).resolves.toBe("");
  });

  it("reports a missing Anthropic key and throws before creating a client", async () => {
    env.anthropicKey = "";

    expect(hasKey()).toBe(false);
    expect(() => getClient()).toThrow("ANTHROPIC_API_KEY");
    await expect(complete("prompt")).rejects.toThrow("ANTHROPIC_API_KEY");
    expect(anthropicMock.Anthropic).not.toHaveBeenCalled();
    expect(anthropicMock.create).not.toHaveBeenCalled();
  });
});

describe("streamComplete", () => {
  function mockStream(
    deltas: string[],
    final: MockMessage
  ): { on: ReturnType<typeof vi.fn>; finalMessage: ReturnType<typeof vi.fn> } {
    let textHandler: ((delta: string) => void) | undefined;
    const on = vi.fn((event: string, handler: (delta: string) => void) => {
      if (event === "text") textHandler = handler;
    });
    const finalMessage = vi.fn(async () => {
      for (const delta of deltas) textHandler?.(delta);
      return final;
    });
    anthropicMock.stream.mockReturnValue({ on, finalMessage });
    return { on, finalMessage };
  }

  it("streams with adaptive thinking and returns text from the final message", async () => {
    const mocked = mockStream(
      ["streamed partial"],
      message([{ type: "text", text: "final text" }], "end_turn")
    );

    await expect(
      streamComplete("prompt", {
        model: "claude-opus-4-8",
        system: "system prompt",
        adaptive: true,
      })
    ).resolves.toBe("final text");

    expect(anthropicMock.stream).toHaveBeenCalledWith({
      model: "claude-opus-4-8",
      max_tokens: 64000,
      system: "system prompt",
      messages: [{ role: "user", content: "prompt" }],
      thinking: { type: "adaptive" },
    });
    expect(mocked.on).toHaveBeenCalledWith("text", expect.any(Function));
    expect(mocked.finalMessage).toHaveBeenCalledOnce();
  });

  it("omits thinking unless adaptive is opted in", async () => {
    mockStream([], message([{ type: "text", text: "done" }], "end_turn"));

    await streamComplete("prompt", { maxTokens: 1234 });

    expect(anthropicMock.stream).toHaveBeenCalledWith({
      model: env.editModel,
      max_tokens: 1234,
      system: undefined,
      messages: [{ role: "user", content: "prompt" }],
    });
  });

  it("throttles progress updates and reports accumulated chars with a 120-character tail", async () => {
    const longDelta = "x".repeat(125);
    mockStream(
      [longDelta, "ignored", "reported"],
      message([{ type: "text", text: "done" }], "end_turn")
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1150);
    const onProgress = vi.fn();

    await streamComplete("prompt", {}, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenNthCalledWith(1, {
      chars: 125,
      tail: "x".repeat(120),
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      chars: 140,
      tail: `${"x".repeat(105)}ignoredreported`,
    });
    now.mockRestore();
  });

  it("emits the final accumulated progress when the last delta was throttled", async () => {
    mockStream(
      ["first", " final"],
      message([{ type: "text", text: "first final" }], "end_turn")
    );
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1050);
    const onProgress = vi.fn();

    await streamComplete("prompt", {}, onProgress);

    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({
      chars: 11,
      tail: "first final",
    });
    now.mockRestore();
  });

  it("rejects truncated final messages unless explicitly allowed", async () => {
    mockStream(
      ["partial"],
      message([{ type: "text", text: "partial" }], "max_tokens")
    );

    await expect(streamComplete("prompt")).rejects.toBeInstanceOf(
      TruncatedError
    );

    mockStream(
      ["partial"],
      message([{ type: "text", text: "partial" }], "max_tokens")
    );
    await expect(
      streamComplete("prompt", { allowTruncated: true })
    ).resolves.toBe("partial");
  });
});
