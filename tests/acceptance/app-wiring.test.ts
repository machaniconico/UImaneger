// @vitest-environment node
// R3 受け入れテスト: createApp が新しい security middleware を /api に配線していること。
// 基準: .omc/plans/r3-csrf-acceptance.md(実装者は編集禁止)
import { describe, it, expect } from "vitest";
import { createApp } from "../../server/app.ts";

const J = { "content-type": "application/json" };

function devApp() {
  return createApp({ production: false, useLogger: false, serverPort: 5174, clientPort: 5173 });
}

describe("app-wiring", () => {
  it("blocks_clone_from_preview_origin_text_plain", async () => {
    const app = devApp();
    const body = JSON.stringify({ url: "https://example.invalid/x.git" });
    const res = await app.request("/api/project/clone", {
      method: "POST",
      headers: { origin: "http://localhost:6100", "content-type": "text/plain" },
      body,
    });
    expect(res.status).toBe(403);
    const noOrigin = await app.request("/api/project/clone", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    expect(noOrigin.status).toBe(415);
  });

  it("blocks_files_write_no_cors_simple_request", async () => {
    const res = await devApp().request("/api/files/write", {
      method: "POST",
      headers: { origin: "http://127.0.0.1:6100", "content-type": "text/plain" },
      body: JSON.stringify({ path: "/tmp/x", content: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("blocks_img_triggered_git_status", async () => {
    const res = await devApp().request("/api/git/status", {
      headers: { "sec-fetch-site": "same-site", "sec-fetch-dest": "image" },
    });
    expect(res.status).toBe(403);
  });

  it("dev_flow_via_vite_proxy_passes", async () => {
    const app = devApp();
    const status = await app.request("/api/status", {
      headers: { host: "localhost:5174", "sec-fetch-site": "same-origin" },
    });
    expect(status.status).toBe(200);
    const stop = await app.request("/api/project/stop", {
      method: "POST",
      headers: { ...J, origin: "http://127.0.0.1:5173" },
      body: "{}",
    });
    expect(stop.status).toBe(200);
  });

  it("curl_without_origin_passes", async () => {
    const app = devApp();
    expect((await app.request("/api/status")).status).toBe(200);
    const stop = await app.request("/api/project/stop", { method: "POST", headers: J, body: "{}" });
    expect(stop.status).toBe(200);
  });

  it("production_same_origin_only", async () => {
    const app = createApp({
      production: true,
      distExists: false,
      useLogger: false,
      serverPort: 5174,
      clientPort: 5173,
    });
    expect((await app.request("/api/status", { headers: { origin: "http://localhost:5174" } })).status).toBe(200);
    expect((await app.request("/api/status", { headers: { origin: "http://localhost:5173" } })).status).toBe(403);
  });
});
