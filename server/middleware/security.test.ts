// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { allowedApiOrigins, createSecurityMiddleware, isAllowedHost } from "./security.ts";

function makeApp(clientPort: number | null = 5173) {
  const app = new Hono();
  app.use("/api/*", createSecurityMiddleware({ serverPort: 5174, clientPort }));
  app.all("/api/test", (c) => c.json({ ok: true }));
  return app;
}

const JSON_HEADERS = { "content-type": "application/json" };

describe("createSecurityMiddleware", () => {
  it("allows the UI origin exactly (dev client port and server port)", async () => {
    const app = makeApp();
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5174", "http://[::1]:5174"]) {
      const res = await app.request("/api/test", {
        method: "POST",
        headers: { ...JSON_HEADERS, origin },
      });
      expect(res.status, origin).toBe(200);
    }
  });

  it("rejects localhost origins on other ports (preview / other local pages)", async () => {
    const res = await makeApp().request("/api/test", {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "http://localhost:6100" },
    });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("rejects non-local, lookalike, subdomain, https and null origins", async () => {
    const app = makeApp();
    for (const origin of [
      "http://evil.com",
      "http://localhost.evil.com:5173",
      "http://app.localhost:5173",
      "https://localhost:5173",
      "null",
    ]) {
      const res = await app.request("/api/test", { headers: { origin } });
      expect(res.status, origin).toBe(403);
    }
  });

  it("drops the client port origin in production (clientPort null)", async () => {
    const app = makeApp(null);
    const dev = await app.request("/api/test", { headers: { origin: "http://localhost:5173" } });
    const prod = await app.request("/api/test", { headers: { origin: "http://localhost:5174" } });
    expect(dev.status).toBe(403);
    expect(prod.status).toBe(200);
  });

  it("allows requests with no Origin header", async () => {
    expect((await makeApp().request("/api/test")).status).toBe(200);
  });

  it("checks Sec-Fetch-Site", async () => {
    const app = makeApp();
    for (const site of ["same-site", "cross-site", "bogus"]) {
      const res = await app.request("/api/test", { headers: { "sec-fetch-site": site } });
      expect(res.status, site).toBe(403);
    }
    for (const site of ["same-origin", "none"]) {
      const res = await app.request("/api/test", { headers: { "sec-fetch-site": site } });
      expect(res.status, site).toBe(200);
    }
  });

  it("requires application/json for unsafe methods", async () => {
    const app = makeApp();
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded", "application/jsonx"]) {
      const res = await app.request("/api/test", {
        method: "POST",
        headers: type ? { "content-type": type } : {},
      });
      expect(res.status, String(type)).toBe(415);
      await expect(res.json()).resolves.toEqual({ error: "unsupported media type" });
    }
    const ok = await app.request("/api/test", {
      method: "POST",
      headers: { "content-type": "Application/JSON; charset=utf-8" },
    });
    expect(ok.status).toBe(200);
  });

  it("returns 403 before 415 when the origin is not allowed", async () => {
    const res = await makeApp().request("/api/test", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "http://localhost:6100" },
    });
    expect(res.status).toBe(403);
  });

  it("allows loopback Host headers on any port and rejects others", async () => {
    const app = makeApp();
    for (const host of ["127.0.0.1:3001", "localhost:5174", "[::1]:5174"]) {
      expect((await app.request("/api/test", { headers: { host } })).status, host).toBe(200);
    }
    for (const host of ["attacker.com", "foo.localhost:5174", "localhost.evil.com"]) {
      const res = await app.request("/api/test", { headers: { host } });
      expect(res.status, host).toBe(403);
    }
  });

  it("never emits CORS headers", async () => {
    const res = await makeApp().request("/api/test", {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: "http://localhost:5173" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("allowedApiOrigins", () => {
  it("lists loopback origins for server and dev client ports", () => {
    expect(allowedApiOrigins({ serverPort: 5174, clientPort: 5173 })).toEqual([
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://[::1]:5174",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://[::1]:5173",
    ]);
    expect(allowedApiOrigins({ serverPort: 5174, clientPort: null })).toHaveLength(3);
  });
});

describe("review follow-ups", () => {
  it("accepts the port-less origin when the server listens on default port 80", async () => {
    const app = new Hono();
    app.use("/api/*", createSecurityMiddleware({ serverPort: 80, clientPort: null }));
    app.get("/api/test", (c) => c.json({ ok: true }));
    const res = await app.request("/api/test", { headers: { origin: "http://localhost" } });
    expect(res.status).toBe(200);
  });

  it("rejects malformed loopback-looking Host headers", async () => {
    const app = makeApp();
    for (const host of ["[::1]suffix", "[::1]:abc", "localhost:abc", "127.0.0.1:", "localhost:5174:1"]) {
      expect(isAllowedHost(host), host).toBe(false);
      const res = await app.request("/api/test", { headers: { host } });
      expect(res.status, host).toBe(403);
    }
  });

  it.each(["[localhost]", "[127.0.0.1]:5174"])("rejects the bracketed non-IPv6 Host %s", async (host) => {
    const res = await makeApp().request("/api/test", { headers: { host } });
    expect(res.status).toBe(403);
  });

  it.each([
    'application/json; profile="a,b"',
    String.raw`application/json; profile="a\",b"`,
  ])("accepts a comma inside a quoted Content-Type parameter (%s)", async (type) => {
    const res = await makeApp().request("/api/test", {
      method: "POST",
      headers: { "content-type": type },
    });
    expect(res.status).toBe(200);
  });

  it.each([
    "application/json; charset=utf-8, text/plain",
    'application/json; profile="a,b", text/plain',
    String.raw`application/json; profile="a\\", text/plain`,
  ])("rejects a comma outside quoted Content-Type parameters (%s)", async (type) => {
    const res = await makeApp().request("/api/test", {
      method: "POST",
      headers: { "content-type": type },
    });
    expect(res.status).toBe(415);
  });

  it.each(["application/json\u00A0", "\u00A0application/json"])(
    "does not treat non-HTTP whitespace as OWS in Content-Type (%j)",
    async (type) => {
      const res = await makeApp().request("/api/test", {
        method: "POST",
        headers: { "content-type": type },
      });
      expect(res.status).toBe(415);
    }
  );

  it.each([" application/json", "application/json\t", "application/json ; charset=utf-8"])(
    "accepts SP/HTAB around the JSON media type (%j)",
    async (type) => {
      const res = await makeApp().request("/api/test", {
        method: "POST",
        headers: { "content-type": type },
      });
      expect(res.status).toBe(200);
    }
  );

  it("rejects Content-Type values combined by Fetch Headers", async () => {
    const headers = new Headers(JSON_HEADERS);
    headers.append("content-type", "text/plain");
    const res = await makeApp().request("/api/test", { method: "POST", headers });
    expect(res.status).toBe(415);
  });
});
