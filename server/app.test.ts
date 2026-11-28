// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, isProduction } from "./app.ts";
import { getPreviewParentOrigins } from "./lib/state.ts";

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

  it("applies API security to the edit-model, streaming and history endpoints", async () => {
    const app = createApp({ useLogger: false, production: false });
    const host = "127.0.0.1:5174";

    for (const path of ["/api/edit/stream", "/api/edit/redo"]) {
      const plain = await app.request(path, {
        method: "POST",
        headers: { host, "content-type": "text/plain" },
        body: "{}",
      });
      expect(plain.status).toBe(415);

      const crossSite = await app.request(path, {
        method: "POST",
        headers: {
          host,
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: "{}",
      });
      expect(crossSite.status).toBe(403);
    }

    for (const path of ["/api/models", "/api/edit/history"]) {
      const foreignHost = await app.request(path, {
        headers: { host: "example.com" },
      });
      expect(foreignHost.status).toBe(403);

      const crossSite = await app.request(path, {
        headers: { host, origin: "https://evil.example" },
      });
      expect(crossSite.status).toBe(403);

      const allowed = await app.request(path, { headers: { host } });
      expect(allowed.status).toBe(200);
    }
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

  it("does not serve the SPA fallback for case-variant or duplicate-slash API and asset paths", async () => {
    const distRoot = createDistFixture();
    const app = createApp({
      distRoot,
      distExists: true,
      production: true,
      useLogger: false,
    });

    for (const path of [
      "/API/files/read",
      "/Api",
      "//api/files",
      "//api/files/read",
      "///api",
      "//assets/missing",
      "/ASSETS/missing",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await app.request(path, {
          method,
          headers: { host: "example.com", accept: "text/html" },
        });
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text(), `${method} ${path}`).not.toContain("UImaneger");
      }
    }
  });
});

describe("isProduction", () => {
  it("is enabled by NODE_ENV=production or the --production argument", () => {
    expect(isProduction({}, ["node", "server/index.ts"], undefined)).toBe(false);
    expect(isProduction({}, ["node", "server/index.ts"], "production")).toBe(true);
    expect(isProduction({}, ["node", "server/index.ts", "--production"], undefined)).toBe(true);
    expect(isProduction({}, ["node", "server/index.ts", "--production=false"], undefined)).toBe(false);
  });

  it("lets an explicit option win over argv and NODE_ENV", () => {
    expect(isProduction({ production: false }, ["--production"], "production")).toBe(false);
    expect(isProduction({ production: true }, [], undefined)).toBe(true);
  });
});

describe("preview parent origins wiring", () => {
  it("passes the UI origin of createApp to the preview proxies", () => {
    createApp({ useLogger: false, production: false, serverPort: 5300, clientPort: 5301 });
    expect(getPreviewParentOrigins()).toEqual(
      expect.arrayContaining(["http://localhost:5301", "http://127.0.0.1:5301"])
    );
    expect(getPreviewParentOrigins()).not.toContain("http://localhost:5300");

    createApp({ useLogger: false, production: true, serverPort: 5300, clientPort: 5301 });
    expect(getPreviewParentOrigins()).toContain("http://localhost:5300");
    expect(getPreviewParentOrigins()).not.toContain("http://localhost:5301");
  });
});
