// S5: parsePort の単体テスト
import { describe, it, expect } from "vitest";
import { parsePort } from "./env.ts";

describe("parsePort", () => {
  it("空文字/undefined は fallback を返す", () => {
    expect(parsePort("", 5174, "UIM_SERVER_PORT")).toBe(5174);
    expect(parsePort("   ", 5174, "UIM_SERVER_PORT")).toBe(5174);
    expect(parsePort(undefined, 5173, "UIM_CLIENT_PORT")).toBe(5173);
  });

  it("1〜65535 の整数はそのまま返す", () => {
    expect(parsePort("1", 5174, "X")).toBe(1);
    expect(parsePort("65535", 5174, "X")).toBe(65535);
    expect(parsePort("5174", 5174, "X")).toBe(5174);
    expect(parsePort(" 5174 ", 5174, "X")).toBe(5174);
  });

  it("非数値は throw", () => {
    expect(() => parsePort("abc", 5174, "UIM_SERVER_PORT")).toThrow(
      /UIM_SERVER_PORT.*1〜65535/
    );
  });

  it("0 は範囲外で throw", () => {
    expect(() => parsePort("0", 5174, "X")).toThrow();
  });

  it("70000 は範囲外で throw", () => {
    expect(() => parsePort("70000", 5174, "X")).toThrow();
  });

  it("小数は整数でないので throw", () => {
    expect(() => parsePort("5174.5", 5174, "X")).toThrow();
  });

  it("十進数字以外の数値表記は throw", () => {
    expect(() => parsePort("1e3", 5174, "X")).toThrow();
    expect(() => parsePort("0x10", 5174, "X")).toThrow();
  });
});
