// @vitest-environment node
// R3 受け入れテスト: 子プロセス env から秘密を除去する buildChildEnv。
// 基準: .omc/plans/r3-csrf-acceptance.md(実装者は編集禁止)
import { describe, it, expect } from "vitest";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv } from "../../server/lib/child-env.ts";
import { findFreePort, killGroup, killAllChildrenSync, sleep, startTarget } from "../../server/lib/runner.ts";

async function canBindLoopback(): Promise<boolean> {
  const server = http.createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  } finally {
    await new Promise<void>((r) => (server.listening ? server.close(() => r()) : r()));
  }
}

const hasLoopback = await canBindLoopback();
const itIfLoopback = hasLoopback ? it : it.skip;

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules") continue;
      listTsFiles(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

describe("child-env", () => {
  it("strips_anthropic_and_uim_keys", () => {
    const base = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_AUTH_TOKEN: "t",
      UIM_SERVER_PORT: "1",
      UIM_HOST: "h",
      UIM_WORKSPACES_DIR: "/w",
    };
    expect(Object.keys(buildChildEnv({}, base, [])).sort()).toEqual(["HOME", "PATH"]);
  });

  it("strips_case_insensitively", () => {
    const env = buildChildEnv({}, { PATH: "p", anthropic_api_key: "k", Uim_Debug: "1" }, []);
    expect(env).not.toHaveProperty("anthropic_api_key");
    expect(env).not.toHaveProperty("Uim_Debug");
    expect(env.PATH).toBe("p");
  });

  it("keeps_lookalike_keys", () => {
    const env = buildChildEnv({}, { MY_UIM_X: "1", XANTHROPIC_KEY: "2" }, []);
    expect(env.MY_UIM_X).toBe("1");
    expect(env.XANTHROPIC_KEY).toBe("2");
  });

  it("strips_dotenv_injected_keys_only_when_listed", () => {
    const base = { PATH: "p", OPENAI_API_KEY: "sk" };
    expect(buildChildEnv({}, base, ["OPENAI_API_KEY"])).not.toHaveProperty("OPENAI_API_KEY");
    expect(buildChildEnv({}, base, []).OPENAI_API_KEY).toBe("sk");
  });

  it("extra_wins_and_is_not_filtered", () => {
    const env = buildChildEnv({ PORT: "5180", GIT_TERMINAL_PROMPT: "0" }, { PORT: "1" }, []);
    expect(env.PORT).toBe("5180");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does_not_mutate_base", () => {
    const base = { PATH: "p", ANTHROPIC_API_KEY: "k", UIM_X: "1" };
    const snapshot = { ...base };
    buildChildEnv({ A: "b" }, base, ["PATH"]);
    expect(base).toEqual(snapshot);
  });

  it("no_raw_process_env_spread_in_server_sources", () => {
    const serverDir = join(process.cwd(), "server");
    const offenders = listTsFiles(serverDir).filter((f) => {
      if (f.endsWith(join("lib", "child-env.ts"))) return false;
      return /\.\.\.\s*process\.env\b/.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });

  itIfLoopback("started_target_does_not_inherit_secrets", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "uim-acc-childenv-"));
    const saved = {
      key: process.env.ANTHROPIC_API_KEY,
      model: process.env.UIM_EDIT_MODEL,
    };
    try {
      process.env.ANTHROPIC_API_KEY = "sk-sentinel";
      process.env.UIM_EDIT_MODEL = "m";
      const out = join(tmp, "env.json");
      writeFileSync(
        join(tmp, "dump-server.cjs"),
        [
          "const http = require('node:http');",
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env));`,
          "http.createServer((_req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1', function () {",
          "  console.log('Listening on ' + this.address().port);",
          "});",
          "",
        ].join("\n")
      );
      const port = await findFreePort(30_400);
      const target = await startTarget(tmp, port, { command: "node dump-server.cjs" });
      try {
        for (let i = 0; i < 50 && !existsSync(out); i++) await sleep(50);
        const env = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
        expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
        expect(env).not.toHaveProperty("UIM_EDIT_MODEL");
        expect(env.PATH).toBeTruthy();
        expect(env.PORT).toBe(String(port));
      } finally {
        await killGroup(target.proc);
      }
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.model === undefined) delete process.env.UIM_EDIT_MODEL;
      else process.env.UIM_EDIT_MODEL = saved.model;
      killAllChildrenSync();
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
