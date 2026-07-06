// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DiffView } from "./DiffView";

const SAMPLE_DIFF = [
  "--- a/foo.tsx",
  "+++ b/foo.tsx",
  "@@ -1,2 +1,2 @@",
  "-old line",
  "+new line",
  " context",
].join("\n");

/** 描画された diff 行のうち、テキストが一致するものを返す。 */
function findLine(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>("pre > div")).find(
    (d) => (d.textContent || "").trim() === text
  );
}

describe("DiffView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("追加行(+)と削除行(-)が区別して描画される", () => {
    const { container } = render(
      <DiffView diff={SAMPLE_DIFF} onApply={() => {}} onReject={() => {}} />
    );

    // 行が描画されている
    expect(findLine(container, "-old line")).toBeDefined();
    expect(findLine(container, "+new line")).toBeDefined();
    expect(findLine(container, "context")).toBeDefined();

    // 色分けクラスで区別されているか検証
    const addLine = findLine(container, "+new line")!;
    expect(addLine.className).toContain("green");
    expect(addLine.className).not.toContain("red");

    const delLine = findLine(container, "-old line")!;
    expect(delLine.className).toContain("red");
    expect(delLine.className).not.toContain("green");

    // context 行は色分け対象外
    const ctxLine = findLine(container, "context")!;
    expect(ctxLine.className).not.toContain("green");
    expect(ctxLine.className).not.toContain("red");
  });

  it("承認ボタン押下で onApply が呼ばれ、onReject は呼ばれない", async () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(<DiffView diff={SAMPLE_DIFF} onApply={onApply} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: "承認して適用" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
  });

  it("却下ボタン押下で onReject が呼ばれ、onApply は呼ばれない", async () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    const user = userEvent.setup();
    render(<DiffView diff={SAMPLE_DIFF} onApply={onApply} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: "却下" }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("busy 中は両ボタンが無効化される", () => {
    render(
      <DiffView diff={SAMPLE_DIFF} busy onApply={() => {}} onReject={() => {}} />
    );
    expect(
      (screen.getByRole("button", { name: "承認して適用" }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "却下" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("コピーボタンで diff をマーカー込みのまま clipboard に渡す", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<DiffView diff={SAMPLE_DIFF} onApply={() => {}} onReject={() => {}} />);

    expect(screen.queryByRole("button", { name: "diff をコピー" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "コピー" }));

    expect(writeText).toHaveBeenCalledWith(SAMPLE_DIFF);
    expect(await screen.findByText("コピー済")).not.toBeNull();
    expect(screen.getByText("コピーしました")).not.toBeNull();
  });
});
