// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildChildEnv } from "./child-env.ts";

describe("buildChildEnv", () => {
  it("strips ANTHROPIC_* / UIM_* (case-insensitive) and keeps lookalikes", () => {
    const base = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "sk",
      anthropic_auth_token: "t",
      UIM_HOST: "0.0.0.0",
      Uim_Debug: "1",
      MY_UIM_X: "keep",
      XANTHROPIC_KEY: "keep",
    };
    expect(buildChildEnv({}, base, [])).toEqual({
      PATH: "/bin",
      MY_UIM_X: "keep",
      XANTHROPIC_KEY: "keep",
    });
  });

  it("strips keys injected from .env", () => {
    const base = { PATH: "/bin", OPENAI_API_KEY: "x" };
    expect(buildChildEnv({}, base, ["OPENAI_API_KEY"])).toEqual({ PATH: "/bin" });
    expect(buildChildEnv({}, base, [])).toEqual(base);
  });

  it("strips only the exact dotenv key on POSIX", () => {
    expect(buildChildEnv({}, { TEST: "shell", test: "file" }, ["test"], "linux")).toEqual({
      TEST: "shell",
    });
  });

  it("strips dotenv keys case-insensitively on win32", () => {
    expect(buildChildEnv({}, { TEST: "file", PATH: "/bin" }, ["test"], "win32")).toEqual({
      PATH: "/bin",
    });
  });

  it.each(["linux", "win32"] as const)("keeps non-ASCII dotenv key lookalikes on %s", (platform) => {
    expect(buildChildEnv({}, { SOFT: "file", ſOFT: "shell" }, ["soft", "SOFT"], platform)).toEqual({
      ſOFT: "shell",
    });
  });

  it("keeps non-ASCII lookalikes when merging extra on win32", () => {
    expect(buildChildEnv({ SOFT: "extra" }, { ſOFT: "shell" }, [], "win32")).toEqual({
      SOFT: "extra",
      ſOFT: "shell",
    });
  });

  it("lets extra win without filtering and does not mutate base", () => {
    const base = { PATH: "/bin", PORT: "1" };
    const result = buildChildEnv({ PORT: "5180", GIT_TERMINAL_PROMPT: "0" }, base, ["PORT"]);
    expect(result).toEqual({ PATH: "/bin", PORT: "5180", GIT_TERMINAL_PROMPT: "0" });
    expect(base).toEqual({ PATH: "/bin", PORT: "1" });
  });
});

describe("buildChildEnv on win32", () => {
  it("merges keys case-insensitively so extra wins (PATH vs Path)", () => {
    const result = buildChildEnv({ Path: "new" }, { PATH: "old", HOME: "/h" }, [], "win32");
    expect(result).toEqual({ Path: "new", HOME: "/h" });
  });

  it("keeps case-distinct keys on other platforms", () => {
    const result = buildChildEnv({ Path: "new" }, { PATH: "old" }, [], "linux");
    expect(result).toEqual({ PATH: "old", Path: "new" });
  });
});
