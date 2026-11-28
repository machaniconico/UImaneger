// @vitest-environment node
// R3 受け入れテスト(件5): プレビューを埋め込める親 origin(CSP frame-ancestors と inspector の双方)。
// 基準: .omc/plans/r3-security-audit-acceptance.md 件5(実装者は編集禁止)
//
// 依存する契約(現状は存在しないので、該当テストが個別に失敗するのが想定どおり):
//   - server/middleware/security.ts の previewParentOrigins export
//   - startProxy の第4引数 { parentOrigins }
// import は動的に行い、契約が無くてもファイル全体は落ちず AC ごとに失敗する。
// previewParentOrigins が未 export の間、他 AC は AC-5-2 が定める値(5173 の 3 表記)を直接渡して
// 「CSP / inspector の振る舞い」自体の失敗を観測できるようにしている(AC-5-2 が export の有無を別途検証する)。
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import { JSDOM } from "jsdom";
import vm from "node:vm";
import { findFreePort } from "../../server/lib/runner.ts";
import { startProxy, type ProxyHandle } from "../../server/lib/proxy.ts";
import { env } from "../../server/lib/env.ts";

const UI_ORIGINS_5173 = ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"];

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const a = server.address();
      if (a && typeof a === "object") resolve(a.port);
      else reject(new Error("no port"));
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

async function canBindLoopback(): Promise<boolean> {
  const s = http.createServer();
  try {
    await listen(s, "127.0.0.1");
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  } finally {
    await closeServer(s);
  }
}

const hasLoopback = await canBindLoopback();

async function securityModule(): Promise<any> {
  return import("../../server/middleware/security.ts");
}

async function expectedParentOrigins(): Promise<string[]> {
  const m = await securityModule();
  if (typeof m.previewParentOrigins === "function") {
    return m.previewParentOrigins({ serverPort: 5174, clientPort: 5173 });
  }
  return UI_ORIGINS_5173; // 契約未実装時のフォールバック(AC-5-2 が別途失敗する)
}

interface Fixture {
  P: number;
  setUpstreamHeaders: (h: Array<[string, string]>) => void;
  cleanup: () => Promise<void>;
}

/** options === undefined のとき startProxy(up, P) と同じ(省略)で起動する。 */
async function setup(options?: { parentOrigins?: readonly string[] }): Promise<Fixture> {
  let headers: Array<[string, string]> = [];
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, [["content-type", "text/html; charset=utf-8"], ...headers]);
    res.end("<!doctype html><html><head></head><body><button id=b>x</button></body></html>");
  });
  const upSockets = new Set<net.Socket>();
  upstream.on("connection", (s) => {
    upSockets.add(s);
    s.once("close", () => upSockets.delete(s));
  });
  const upPort = await listen(upstream, "127.0.0.1");
  const P = await findFreePort(32_000);
  let proxy: ProxyHandle | undefined;
  try {
    proxy =
      options === undefined
        ? await startProxy(upPort, P)
        : await (startProxy as any)(upPort, P, "127.0.0.1", options);
  } catch (err) {
    await closeServer(upstream);
    throw err;
  }
  return {
    P,
    setUpstreamHeaders: (h) => {
      headers = h;
    },
    cleanup: async () => {
      const closing = closeServer(upstream);
      for (const s of upSockets) s.destroy();
      await proxy?.close().catch(() => {});
      await closing;
    },
  };
}

interface Got {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
  rawHeaders: string[];
}

function get(P: number, path: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: P, method: "GET", path, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers, rawHeaders: res.rawHeaders })
      );
    });
    req.on("error", reject);
    req.end();
  });
}

function headerValues(got: Got, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < got.rawHeaders.length; i += 2) {
    if (got.rawHeaders[i].toLowerCase() === name) out.push(got.rawHeaders[i + 1]);
  }
  return out;
}

/** CSP ヘッダ群をポリシー単位(カンマ区切り)に分け、ディレクティブの Map にする。 */
function parsePolicies(got: Got): Array<Map<string, string[]>> {
  const policies: Array<Map<string, string[]>> = [];
  for (const value of headerValues(got, "content-security-policy")) {
    for (const policy of value.split(",")) {
      const m = new Map<string, string[]>();
      const dupes: string[] = [];
      for (const part of policy.split(";")) {
        const toks = part.trim().split(/\s+/).filter(Boolean);
        if (toks.length === 0) continue;
        const name = toks[0].toLowerCase();
        if (m.has(name)) dupes.push(name);
        else m.set(name, toks.slice(1));
      }
      if (dupes.length) m.set("__dupes__", dupes);
      if (m.size) policies.push(m);
    }
  }
  return policies;
}

function expectFrameAncestorsOnlyUi(policies: Array<Map<string, string[]>>, label: string): void {
  expect(policies.length, `${label}: CSP ポリシー数`).toBeGreaterThan(0);
  for (const [i, p] of policies.entries()) {
    const tag = `${label} policy#${i}`;
    expect((p.get("__dupes__") ?? []).filter((n) => n === "frame-ancestors"), `${tag}: frame-ancestors 重複`).toEqual([]);
    const fa = p.get("frame-ancestors");
    expect(fa, `${tag}: frame-ancestors が無い`).toBeDefined();
    const set = new Set(fa);
    for (const need of ["'self'", "http://localhost:5173", "http://127.0.0.1:5173"]) {
      expect(set.has(need), `${tag}: ${need} を含む (got ${fa!.join(" ")})`).toBe(true);
    }
    for (const tok of fa!) {
      expect(tok.includes("*"), `${tag}: '*' を含むトークン ${tok}`).toBe(false);
      expect(
        ["'self'", "http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"].includes(tok),
        `${tag}: 想定外トークン ${tok}`
      ).toBe(true);
    }
  }
}

let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

// ---- inspector 評価(server/inspector-client.test.ts と同じ jsdom + vm 方式)----
interface PostedMessage {
  message: any;
  targetOrigin: string;
}

function loadInspectorFrom(source: string): {
  messages: PostedMessage[];
  doc: Document;
  win: Window;
  dispatchParentMessage: (data: unknown, origin: string) => void;
} {
  // jsdom 環境だと findFreePort 等の node 側 import が URL 実装の差で落ちるため、node 環境で JSDOM を手動生成する。
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const frame = dom.window.document.createElement("iframe");
  dom.window.document.body.appendChild(frame);
  const win = frame.contentWindow!;
  const doc = frame.contentDocument!;
  doc.head.innerHTML = "";
  doc.body.innerHTML = "";
  delete (win as any).__uimInspectorLoaded;
  const messages: PostedMessage[] = [];
  (win.parent as any).postMessage = (message: unknown, targetOrigin: string) => {
    messages.push({ message, targetOrigin });
  };
  const context = vm.createContext({
    window: win,
    document: doc,
    URL,
    module: { exports: {} },
    console,
    setTimeout,
    clearTimeout,
    ResizeObserver: undefined,
    requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0),
  });
  vm.runInContext(source, context, { filename: "proxy:/__uim/inspector.js" });
  return {
    messages,
    doc,
    win,
    dispatchParentMessage: (data, origin) => {
      win.dispatchEvent(new (win as any).MessageEvent("message", { data, origin, source: win.parent }));
    },
  };
}

async function fetchInspector(): Promise<{ source: string; got: Got; P: number }> {
  const parentOrigins = await expectedParentOrigins();
  fixture = await setup({ parentOrigins });
  const got = await get(fixture.P, "/__uim/inspector.js");
  expect(got.status, "inspector.js status").toBe(200);
  return { source: got.body, got, P: fixture.P };
}

// loopback を bind できない環境ではこのファイルの AC は登録されない(対象外。skip ゲート対策)。
if (hasLoopback) describe("件5 preview parent origin", () => {
  it("AC-5-1 csp_frame_ancestors_lists_only_self_and_ui_origins", async () => {
    const parentOrigins = await expectedParentOrigins();
    fixture = await setup({ parentOrigins });
    const cases: Array<[string, Array<[string, string]>]> = [
      ["CSP なし", []],
      ["frame-ancestors *", [["content-security-policy", "frame-ancestors *"]]],
      ["frame-ancestors 'none'; default-src 'self'", [["content-security-policy", "frame-ancestors 'none'; default-src 'self'"]]],
      [
        "CSP ヘッダ 2 本",
        [
          ["content-security-policy", "default-src 'self'"],
          ["content-security-policy", "frame-ancestors 'none'"],
        ],
      ],
      ["x-frame-options: DENY", [["x-frame-options", "DENY"]]],
    ];
    for (const [label, hdrs] of cases) {
      fixture.setUpstreamHeaders(hdrs);
      const got = await get(fixture.P, "/");
      expect(got.status, `${label}: status`).toBe(200);
      const policies = parsePolicies(got);
      expectFrameAncestorsOnlyUi(policies, label);
      if (label.includes("default-src")) {
        expect(
          policies.some((p) => (p.get("default-src") ?? []).join(" ") === "'self'"),
          `${label}: default-src 'self' が維持される`
        ).toBe(true);
      }
      if (label === "CSP ヘッダ 2 本") {
        expect(
          policies.some((p) => (p.get("default-src") ?? []).join(" ") === "'self'"),
          `${label}: default-src 'self' が維持される`
        ).toBe(true);
      }
      expect(got.headers["x-frame-options"], `${label}: x-frame-options`).toBeUndefined();
    }
    await fixture.cleanup();

    // 追加: options 省略の startProxy(up, P)
    fixture = await setup();
    const got = await get(fixture.P, "/");
    const all = headerValues(got, "content-security-policy").join(" ");
    expect(all, "options 省略: env.clientPort の origin").toContain(`http://localhost:${env.clientPort}`);
    expect(all.includes("*"), "options 省略: '*' を含まない").toBe(false);
  });

  it("AC-5-2 preview_parent_origins_follow_mode_and_ports", async () => {
    const m = await securityModule();
    expect(typeof m.previewParentOrigins, "previewParentOrigins が export されていない").toBe("function");
    const sorted = (xs: string[]) => [...xs].sort();
    const three = (p: number) => sorted([`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`]);

    expect(sorted(m.previewParentOrigins({ serverPort: 5174, clientPort: 5173 }))).toEqual(three(5173));
    expect(sorted(m.previewParentOrigins({ serverPort: 5174, clientPort: null }))).toEqual(three(5174));
    expect(sorted(m.previewParentOrigins({ serverPort: 5174, clientPort: 5174 }))).toEqual(three(5174));
    const p80: string[] = m.previewParentOrigins({ serverPort: 80, clientPort: null });
    expect(p80).toContain("http://localhost");
    expect(p80).toContain("http://localhost:80");
  });

  it("AC-5-3 inspector_accepts_only_configured_parent_origins", async () => {
    const { source, got, P } = await fetchInspector();
    const cc = String(got.headers["cache-control"] ?? "").split(",").map((t) => t.trim().toLowerCase());
    expect(cc, "inspector.js の cache-control に no-store ディレクティブ").toContain("no-store");

    // 評価直後(受信前)は 0 回
    expect(loadInspectorFrom(source).messages, "評価直後").toEqual([]);

    for (const x of UI_ORIGINS_5173) {
      const { messages, dispatchParentMessage } = loadInspectorFrom(source);
      dispatchParentMessage({ type: "uim:ping" }, x);
      expect(messages, `信頼 origin ${x}`).toEqual([
        { message: { type: "uim:ready" }, targetOrigin: x },
        { message: { type: "uim:pong" }, targetOrigin: x },
      ]);
    }

    const untrusted = [
      "http://localhost:6100",
      "http://localhost:5174",
      `http://localhost:${P}`,
      "http://app.localhost:5173",
      "https://localhost:5173",
      "http://localhost.evil.com:5173",
      "http://evil.example",
      "null",
    ];
    for (const x of untrusted) {
      const { messages, dispatchParentMessage } = loadInspectorFrom(source);
      dispatchParentMessage({ type: "uim:ping" }, x);
      expect(messages, `非信頼 origin ${x} への postMessage`).toHaveLength(0);
    }
  });

  it("AC-5-4 inspector_never_sends_selection_to_untrusted_parent", async () => {
    const { source } = await fetchInspector();
    const { messages, doc, win, dispatchParentMessage } = loadInspectorFrom(source);
    doc.body.innerHTML = `<button id="target">Target</button>`;
    const button = doc.getElementById("target")!;
    const click = () => {
      const ev = new (win as any).MouseEvent("click", { bubbles: true, cancelable: true });
      button.dispatchEvent(ev);
      return ev;
    };

    // (a) 非信頼 origin からの setEnabled → クリックしても何も送らず、選択モードは無効のまま
    dispatchParentMessage({ type: "uim:setEnabled", value: true }, "http://localhost:6100");
    const evA = click();
    expect(messages, "(a) 非信頼 origin 後の postMessage").toHaveLength(0);
    expect(evA.defaultPrevented, "(a) 選択モードが有効化された").toBe(false);

    // (b) 信頼 origin からの setEnabled → クリックで uim:select が 1 回、targetOrigin は固定
    dispatchParentMessage({ type: "uim:setEnabled", value: true }, "http://localhost:5173");
    click();
    const selects = messages.filter((m) => m.message?.type === "uim:select");
    expect(selects, "(b) uim:select 回数").toHaveLength(1);
    expect(selects[0].targetOrigin).toBe("http://localhost:5173");
    for (const m of messages) expect(m.targetOrigin, "targetOrigin が '*'").not.toBe("*");

    // (c) 別の信頼 origin からの ping は無視(最初に信頼した origin に固定)
    const before = messages.length;
    dispatchParentMessage({ type: "uim:ping" }, "http://127.0.0.1:5173");
    expect(messages.length, "(c) 別 origin の ping は無視").toBe(before);
  });
});
