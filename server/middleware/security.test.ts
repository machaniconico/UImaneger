// @vitest-environment node
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { securityMiddleware } from "./security.ts";

const app = new Hono();
app.use("/api/*", securityMiddleware);
app.get("/api/test", (c) => c.json({ ok: true }));

describe("securityMiddleware", () => {
  it("allows localhost origins on any port", async () => {
    const res = await app.request("/api/test", {
      headers: { origin: "http://localhost:5173" },
    });

    expect(res.status).toBe(200);
  });

  it("rejects non-local origins", async () => {
    const res = await app.request("/api/test", {
      headers: { origin: "http://evil.com" },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });

  it("rejects localhost lookalike origins", async () => {
    const res = await app.request("/api/test", {
      headers: { origin: "http://localhost.evil.com" },
    });

    expect(res.status).toBe(403);
  });

  it("allows requests with no Origin header", async () => {
    const res = await app.request("/api/test");

    expect(res.status).toBe(200);
  });

  it("allows loopback Host headers on any port", async () => {
    const res = await app.request("/api/test", {
      headers: { host: "127.0.0.1:3001" },
    });

    expect(res.status).toBe(200);
  });

  it("rejects non-local Host headers", async () => {
    const res = await app.request("/api/test", {
      headers: { host: "attacker.com" },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "forbidden" });
  });
});
