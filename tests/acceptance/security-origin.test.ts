// @vitest-environment node
// R3 受け入れテスト: createSecurityMiddleware の Origin / Sec-Fetch-Site / Content-Type / Host 規則。
// 基準: .omc/plans/r3-csrf-acceptance.md(実装者は編集禁止)
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { createSecurityMiddleware } from "../../server/middleware/security.ts";

const J = { "content-type": "application/json" };

function makeApp(clientPort: number | null = 5173): Hono {
  const app = new Hono();
  app.use("/api/*", createSecurityMiddleware({ serverPort: 5174, clientPort }));
  app.all("/api/test", (c) => c.json({ ok: true }));
  return app;
}

function call(
  app: Hono,
  method: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  const hasBody = !["GET", "HEAD", "OPTIONS"].includes(method);
  return Promise.resolve(
    app.request("/api/test", { method, headers, ...(hasBody ? { body: "{}" } : {}) })
  );
}

describe("security-origin", () => {
  it("allows_dev_client_origin_post", async () => {
    const res = await call(makeApp(), "POST", { ...J, origin: "http://localhost:5173" });
    expect(res.status).toBe(200);
  });

  it("allows_all_loopback_names_on_allowed_ports", async () => {
    for (const origin of [
      "http://127.0.0.1:5173",
      "http://localhost:5174",
      "http://127.0.0.1:5174",
      "http://[::1]:5174",
    ]) {
      const res = await call(makeApp(), "POST", { ...J, origin });
      expect(res.status, origin).toBe(200);
    }
  });

  it("rejects_loopback_origin_on_other_port", async () => {
    for (const origin of ["http://localhost:6100", "http://127.0.0.1:5180"]) {
      const res = await call(makeApp(), "POST", { ...J, origin });
      expect(res.status, origin).toBe(403);
      expect(await res.json(), origin).toEqual({ error: "forbidden" });
    }
  });

  it("rejects_subdomain_https_null_malformed_foreign_origin", async () => {
    for (const origin of [
      "http://app.localhost:5173",
      "https://localhost:5173",
      "null",
      "not a url",
      "http://localhost.evil.com:5173",
      "http://evil.com",
    ]) {
      const res = await call(makeApp(), "POST", { ...J, origin });
      expect(res.status, origin).toBe(403);
    }
  });

  it("rejects_client_port_origin_when_client_port_null", async () => {
    const app = makeApp(null);
    expect((await call(app, "POST", { ...J, origin: "http://localhost:5173" })).status).toBe(403);
    expect((await call(app, "POST", { ...J, origin: "http://localhost:5174" })).status).toBe(200);
  });

  it("rejects_get_with_disallowed_origin", async () => {
    const res = await call(makeApp(), "GET", { origin: "http://localhost:6100" });
    expect(res.status).toBe(403);
  });

  it("allows_requests_without_origin", async () => {
    const app = makeApp();
    expect((await call(app, "GET")).status).toBe(200);
    expect((await call(app, "POST", J)).status).toBe(200);
  });

  it("rejects_same_site_and_cross_site_get_without_origin", async () => {
    for (const site of ["same-site", "cross-site", "bogus"]) {
      const res = await call(makeApp(), "GET", { "sec-fetch-site": site });
      expect(res.status, site).toBe(403);
    }
  });

  it("allows_same_origin_and_none_fetch_site", async () => {
    const app = makeApp();
    for (const site of ["same-origin", "none"]) {
      expect((await call(app, "GET", { "sec-fetch-site": site })).status, site).toBe(200);
    }
    const res = await call(app, "POST", {
      ...J,
      origin: "http://localhost:5173",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(200);
  });

  it("rejects_cross_site_even_with_allowed_origin", async () => {
    const res = await call(makeApp(), "POST", {
      ...J,
      origin: "http://localhost:5173",
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
  });

  it("rejects_unsafe_method_without_content_type", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const app = makeApp();
      const res = await Promise.resolve(app.request("/api/test", { method }));
      expect(res.status, method).toBe(415);
      expect(await res.json(), method).toEqual({ error: "unsupported media type" });
    }
  });

  it("rejects_simple_request_content_types", async () => {
    for (const ct of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonx",
      "text/plain; application/json",
    ]) {
      const res = await call(makeApp(), "POST", { "content-type": ct });
      expect(res.status, ct).toBe(415);
    }
  });

  it("accepts_json_with_charset_and_mixed_case", async () => {
    for (const ct of ["application/json; charset=utf-8", "Application/JSON"]) {
      const res = await call(makeApp(), "POST", { "content-type": ct });
      expect(res.status, ct).toBe(200);
    }
  });

  it("safe_methods_do_not_require_content_type", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await call(makeApp(), method);
      expect(res.status, method).not.toBe(415);
    }
  });

  it("origin_violation_precedes_content_type", async () => {
    const res = await call(makeApp(), "POST", {
      "content-type": "text/plain",
      origin: "http://localhost:6100",
    });
    expect(res.status).toBe(403);
  });

  it("allows_loopback_host_any_port", async () => {
    for (const host of ["127.0.0.1:3001", "localhost:5174", "[::1]:5174"]) {
      const res = await call(makeApp(), "GET", { host });
      expect(res.status, host).toBe(200);
    }
  });

  it("rejects_non_loopback_and_subdomain_host", async () => {
    for (const host of ["attacker.com", "attacker.com:5174", "foo.localhost:5174", "localhost.evil.com"]) {
      const res = await call(makeApp(), "GET", { host });
      expect(res.status, host).toBe(403);
    }
  });

  it("preflight_never_grants_cors", async () => {
    const app = makeApp();
    const pre = await call(app, "OPTIONS", {
      origin: "http://evil.com",
      "access-control-request-method": "POST",
    });
    expect(pre.status).toBe(403);
    expect(pre.headers.get("access-control-allow-origin")).toBeNull();

    const ok = await call(app, "POST", { ...J, origin: "http://localhost:5173" });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
  });
});
