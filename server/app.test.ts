// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";

const tempDirs: string[] = [];

function createDistFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "uim-dist-"));
  tempDirs.push(dir);
  mkdirSync(join(dir, "assets"));
  writeFileSync(
    join(dir, "index.html"),
    "<!doctype html><html><body><div id=\"root\">UImaneger</div></body></html>"
  );
  writeFileSync(join(dir, "assets", "app.js"), "console.log('asset ok');");
  return dir;
}

describe("createApp", () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves /health without applying API host restrictions", async () => {
    const app = createApp({ useLogger: false, production: false });

    const res = await app.request("/health", {
      headers: { host: "example.com" },
    });

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("ok");
  });

  it("applies localhost host restrictions to API routes", async () => {
    const app = createApp({ useLogger: false, production: false });

    const blocked = await app.request("/api/status", {
      headers: { host: "example.com" },
    });
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toEqual({ error: "forbidden" });

    const allowed = await app.request("/api/status", {
      headers: { host: "127.0.0.1:5174" },
    });
    expect(allowed.status).toBe(200);
    await expect(allowed.json()).resolves.toMatchObject({
      info: null,
      hasKey: expect.any(Boolean),
    });
  });

  it("serves production dist files without bypassing API security", async () => {
    const distRoot = createDistFixture();
    const app = createApp({
      distRoot,
      distExists: true,
      production: true,
      useLogger: false,
    });

    const index = await app.request("/", {
      headers: { host: "example.com" },
    });
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toContain("text/html");
    await expect(index.text()).resolves.toContain("UImaneger");

    const asset = await app.request("/assets/app.js", {
      headers: { host: "example.com" },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("javascript");
    await expect(asset.text()).resolves.toContain("asset ok");

    const api = await app.request("/api/status", {
      headers: { host: "example.com" },
    });
    expect(api.status).toBe(403);
  });

  it("falls back to index.html for production SPA routes only", async () => {
    const distRoot = createDistFixture();
    const app = createApp({
      distRoot,
      distExists: true,
      production: true,
      useLogger: false,
    });

    const route = await app.request("/workspace/demo", {
      headers: { host: "example.com", accept: "text/html" },
    });
    expect(route.status).toBe(200);
    expect(route.headers.get("content-type")).toContain("text/html");
    await expect(route.text()).resolves.toContain("UImaneger");

    const missingAsset = await app.request("/assets/missing.js", {
      headers: { host: "example.com", accept: "*/*" },
    });
    expect(missingAsset.status).toBe(404);

    const missingFile = await app.request("/favicon.ico", {
      headers: { host: "example.com", accept: "image/*" },
    });
    expect(missingFile.status).toBe(404);
  });
});
