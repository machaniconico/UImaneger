import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fixtures } from "./runtime-matrix-fixtures.mjs";

const vite = fixtures.find(({ name }) => name === "Vite + React");
let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "uim-matrix-test-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it("reports the npm command when dependency JSON is empty", async () => {
  const run = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("");
  await expect(vite.prepare({ root, marker: "test", platform: "win32", run }))
    .rejects.toThrow("npm ls --depth=0 --json returned no stdout");
});

it("allows 10 minutes for Windows npm installs with cache revalidation", async () => {
  const run = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(
    '{"dependencies":{"vite":{"version":"7.3.1"}}}'
  );
  await expect(vite.prepare({ root, marker: "test", platform: "win32", run }))
    .resolves.toEqual({ vite: "7.3.1" });
  expect(run).toHaveBeenNthCalledWith(1, "npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=warn",
  ], { timeoutMs: 600_000 });
  expect(run).toHaveBeenNthCalledWith(2, "npm", ["ls", "--depth=0", "--json"], { capture: true });
});
