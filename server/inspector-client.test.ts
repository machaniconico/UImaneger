// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

interface InspectorPayload {
  tag: string;
  id?: string;
  classes: string[];
  attrs: Record<string, string>;
  textSnippet?: string;
  domPath: string;
  source?: unknown;
}

interface InspectorHelpers {
  isTrustedOrigin: (origin: string) => boolean;
  safeProps: (props: unknown) => Record<string, unknown> | undefined;
  textWithBoundaries: (el: Element) => string;
  describe: (el: Element) => InspectorPayload;
  isKeyboardCandidate: (el: Element) => boolean;
  getKeyboardCandidates: () => Element[];
  eventElement: (event: Event) => Element | null;
}

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// プロキシは配信時に許可する親 origin を埋め込む(server/lib/proxy.ts)。テストでは
// dev の UI(clientPort 5173)を許可した状態を再現する。
const PARENT_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://[::1]:5173",
];
const inspectorSource = readFileSync(
  join(__dirname, "inspector-client.js"),
  "utf8"
).replace("/*__UIM_PARENT_ORIGINS__*/ []", JSON.stringify(PARENT_ORIGINS));

function loadInspector(referrer = "https://editor.example/projects/1"): {
  helpers: InspectorHelpers;
  messages: PostedMessage[];
  doc: Document;
  win: Window;
  dispatchParentMessage: (data: unknown, origin: string) => void;
} {
  document.body.innerHTML = "";
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  const doc = frame.contentDocument!;
  doc.head.innerHTML = "";
  doc.body.innerHTML = "";
  delete (win as typeof window & { __uimInspectorLoaded?: boolean })
    .__uimInspectorLoaded;
  Object.defineProperty(doc, "referrer", {
    configurable: true,
    value: referrer,
  });

  const messages: PostedMessage[] = [];
  const parentWindow = win.parent as Window & {
    postMessage: (message: unknown, targetOrigin: string) => void;
  };
  parentWindow.postMessage = (message: unknown, targetOrigin: string) => {
    messages.push({ message, targetOrigin });
  };

  const module = { exports: {} };
  const context = vm.createContext({
    window: win,
    document: doc,
    URL,
    module,
    console,
    setTimeout,
    clearTimeout,
    ResizeObserver:
      typeof ResizeObserver === "undefined" ? undefined : ResizeObserver,
    requestAnimationFrame: (callback: (time: number) => void) =>
      setTimeout(() => callback(Date.now()), 0),
  });

  vm.runInContext(inspectorSource, context, {
    filename: "server/inspector-client.js",
  });

  return {
    helpers: module.exports as InspectorHelpers,
    messages,
    doc,
    win,
    dispatchParentMessage: (data: unknown, origin: string) => {
      win.dispatchEvent(
        new MessageEvent("message", {
          data,
          origin,
          source: win.parent,
        })
      );
    },
  };
}

function stubVisibleRect(el: Element, index: number) {
  const left = index * 120;
  const top = index * 40;
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        x: left,
        y: top,
        left,
        top,
        right: left + 100,
        bottom: top + 24,
        width: 100,
        height: 24,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

function dispatchKey(
  _win: Window,
  doc: Document,
  key: string,
  init: KeyboardEventInit = {}
) {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  doc.body.dispatchEvent(event);
  return event;
}

describe("inspector-client helpers", () => {
  it("keeps the selected element payload backward-compatible", () => {
    const { helpers, doc } = loadInspector();
    doc.body.innerHTML = `
      <main>
        <button
          id="save"
          class="primary large"
          data-testid="save-button"
          data-component="ToolbarButton"
        >
          Save
          now
        </button>
      </main>
    `;

    const el = doc.querySelector("button");
    expect(el).not.toBeNull();

    const payload = helpers.describe(el!);
    expect(payload).toMatchObject({
      tag: "button",
      id: "save",
      classes: ["primary", "large"],
      attrs: {
        id: "save",
        class: "primary large",
        "data-testid": "save-button",
        "data-component": "ToolbarButton",
      },
      textSnippet: "Save now",
      domPath: "#save",
    });
    expect(Object.prototype.hasOwnProperty.call(payload, "source")).toBe(true);
  });

  it("reduces props to JSON-safe primitive values", () => {
    const { helpers } = loadInspector();
    const props: Record<string, unknown> = {
      label: "Save",
      count: 2,
      enabled: true,
      empty: null,
      onClick: () => {},
      nested: { value: "ignored" },
      proxied: new Proxy({ value: "ignored" }, {}),
    };
    Object.defineProperty(props, "throws", {
      enumerable: true,
      get() {
        throw new Error("unsafe getter");
      },
    });

    const safe = helpers.safeProps(props);
    expect(safe).toEqual({
      label: "Save",
      count: 2,
      enabled: true,
      empty: null,
    });
    expect(() => JSON.stringify(safe)).not.toThrow();
  });

  it("adds spaces at child element boundaries in text snippets", () => {
    const { helpers, doc } = loadInspector();
    doc.body.innerHTML = `
      <div id="label"><span>Hello</span><span>World</span><em>Again</em></div>
    `;

    const payload = helpers.describe(doc.querySelector("#label")!);
    expect(payload.textSnippet).toBe("Hello World Again");
  });

  it("uses the innermost composed-path element inside open shadow DOM", () => {
    const { helpers, doc } = loadInspector();
    const host = doc.createElement("preview-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = doc.createElement("button");
    button.textContent = "Shadow action";
    shadow.appendChild(button);
    doc.body.appendChild(host);

    const event = {
      target: host,
      composedPath: () => [button, shadow, host, doc.body, doc, doc.defaultView],
    } as unknown as Event;

    expect(helpers.eventElement(event)).toBe(button);
  });

  it("includes visible controls in open shadow roots for keyboard selection", () => {
    const { helpers, doc } = loadInspector();
    const host = doc.createElement("preview-card");
    const shadow = host.attachShadow({ mode: "open" });
    const button = doc.createElement("button");
    button.textContent = "Shadow action";
    stubVisibleRect(button, 0);
    shadow.appendChild(button);
    doc.body.appendChild(host);

    expect(helpers.getKeyboardCandidates()).toContain(button);
  });

  it("trusts only the embedded UI origins", () => {
    const { helpers } = loadInspector();

    expect(helpers.isTrustedOrigin("http://localhost:5173")).toBe(true);
    expect(helpers.isTrustedOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(helpers.isTrustedOrigin("http://[::1]:5173")).toBe(true);
    expect(helpers.isTrustedOrigin("http://app.localhost:5173")).toBe(false);
    expect(helpers.isTrustedOrigin("http://localhost:6100")).toBe(false);
    expect(helpers.isTrustedOrigin("https://localhost:5173")).toBe(false);
    expect(helpers.isTrustedOrigin("https://evil.com")).toBe(false);
    expect(helpers.isTrustedOrigin("http://localhost.evil.com")).toBe(false);
    expect(helpers.isTrustedOrigin("not a url")).toBe(false);
  });

  it("does not post ready from document.referrer or wildcard before trust is established", () => {
    const { messages } = loadInspector(
      "https://editor.example/projects/1?preview=1"
    );

    expect(messages).toEqual([]);
  });

  it("rejects inbound messages from non-localhost parent origins", () => {
    const { doc, dispatchParentMessage, messages } = loadInspector();

    dispatchParentMessage(
      { type: "uim:previewCss", css: "body { color: red; }" },
      "https://evil.com"
    );

    expect(doc.querySelector("#uim-preview-style")).toBeNull();
    expect(messages).toEqual([]);
  });

  it("uses the first trusted parent origin for outbound messages", () => {
    const { dispatchParentMessage, messages } = loadInspector();

    dispatchParentMessage({ type: "uim:ping" }, "http://localhost:5173");
    dispatchParentMessage({ type: "uim:ping" }, "http://127.0.0.1:5173");

    expect(messages).toEqual([
      {
        message: { type: "uim:ready" },
        targetOrigin: "http://localhost:5173",
      },
      {
        message: { type: "uim:pong" },
        targetOrigin: "http://localhost:5173",
      },
    ]);
  });

  it("selects keyboard candidates when selection mode is enabled", () => {
    const { doc, win, dispatchParentMessage, messages } = loadInspector();
    doc.body.innerHTML = `
      <button id="first">First</button>
      <button id="second">Second</button>
      <button id="third">Third</button>
    `;
    Array.from(doc.querySelectorAll("button")).forEach(stubVisibleRect);

    dispatchParentMessage(
      { type: "uim:setEnabled", value: true },
      "http://localhost:5173"
    );
    messages.length = 0;

    expect(dispatchKey(win, doc, "ArrowRight").defaultPrevented).toBe(true);
    expect(dispatchKey(win, doc, "Enter").defaultPrevented).toBe(true);

    const selects = messages.filter(
      (m) => (m.message as { type: string }).type === "uim:select"
    );
    expect(selects).toHaveLength(1);
    expect(selects[0].targetOrigin).toBe("http://localhost:5173");
    expect(selects[0].message).toMatchObject({
      type: "uim:select",
      payload: { tag: "button", id: "second", textSnippet: "Second" },
    });
  });

  it("leaves keyboard events alone when selection mode is disabled", () => {
    const { doc, win, dispatchParentMessage, messages } = loadInspector();
    doc.body.innerHTML = `
      <button id="first">First</button>
      <button id="second">Second</button>
    `;
    Array.from(doc.querySelectorAll("button")).forEach(stubVisibleRect);

    dispatchParentMessage({ type: "uim:ping" }, "http://localhost:5173");
    messages.length = 0;

    expect(dispatchKey(win, doc, "ArrowRight").defaultPrevented).toBe(false);
    expect(dispatchKey(win, doc, "Enter").defaultPrevented).toBe(false);
    expect(messages).toEqual([]);
  });
});

describe("inspector keyboard tree navigation", () => {
  const PARENT = "http://localhost:5173";

  function setup(html: string) {
    const ctx = loadInspector();
    ctx.doc.body.innerHTML = html;
    Array.from(ctx.doc.body.querySelectorAll("*")).forEach(stubVisibleRect);
    return ctx;
  }
  const enable = (ctx: ReturnType<typeof loadInspector>) => {
    ctx.dispatchParentMessage({ type: "uim:setEnabled", value: true }, PARENT);
  };
  const types = (ctx: ReturnType<typeof loadInspector>) =>
    ctx.messages.map((m) => (m.message as { type: string }).type);
  const lastSelect = (ctx: ReturnType<typeof loadInspector>) =>
    [...ctx.messages]
      .reverse()
      .find((m) => (m.message as { type: string }).type === "uim:select")
      ?.message as { payload: { id?: string } } | undefined;

  const TREE = `
    <main id="root">
      <h1 id="title">サンプルアプリ</h1>
      <section id="sec"><p id="p1">one</p><p id="p2">two</p></section>
      <div id="hidden" hidden>x</div>
      <footer id="foot">f</footer>
    </main>`;

  it("starts at the first visible body child and ArrowDown/Up/Right/Left walk the tree", () => {
    const ctx = setup(TREE);
    enable(ctx);
    const { doc, win } = ctx;
    // 初期候補 = body の最初の可視子要素 (main)
    expect(dispatchKey(win, doc, "ArrowDown").defaultPrevented).toBe(true); // -> h1
    dispatchKey(win, doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("title");
    dispatchKey(win, doc, "ArrowRight"); // -> section
    dispatchKey(win, doc, "ArrowDown"); // -> p1
    dispatchKey(win, doc, "ArrowRight"); // -> p2
    dispatchKey(win, doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("p2");
    dispatchKey(win, doc, "ArrowLeft"); // -> p1
    dispatchKey(win, doc, "ArrowUp"); // -> section
    dispatchKey(win, doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("sec");
  });

  it("skips hidden siblings and does not climb above body's children", () => {
    const ctx = setup(TREE);
    enable(ctx);
    const { doc, win } = ctx;
    dispatchKey(win, doc, "ArrowDown"); // h1
    dispatchKey(win, doc, "ArrowRight"); // section
    dispatchKey(win, doc, "ArrowRight"); // footer (hidden div skipped)
    dispatchKey(win, doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("foot");
    dispatchKey(win, doc, "ArrowUp"); // main
    dispatchKey(win, doc, "ArrowUp"); // stays at main (body/html are skipped)
    dispatchKey(win, doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("root");
  });

  it("prefers the focused element as the initial candidate", () => {
    const ctx = setup(`<button id="a">A</button><button id="b">B</button>`);
    (ctx.doc.getElementById("b") as HTMLElement).focus();
    enable(ctx);
    dispatchKey(ctx.win, ctx.doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("b");
  });

  it("Space confirms like Enter", () => {
    const ctx = setup(TREE);
    enable(ctx);
    expect(dispatchKey(ctx.win, ctx.doc, " ").defaultPrevented).toBe(true);
    expect(lastSelect(ctx)?.payload.id).toBe("root");
  });

  it("Escape sends uim:cancel to the trusted parent", () => {
    const ctx = setup(TREE);
    enable(ctx);
    ctx.messages.length = 0;
    expect(dispatchKey(ctx.win, ctx.doc, "Escape").defaultPrevented).toBe(true);
    expect(ctx.messages).toEqual([
      { message: { type: "uim:cancel" }, targetOrigin: PARENT },
    ]);
  });

  it("announces each candidate to the trusted parent origin only", () => {
    const ctx = setup(TREE);
    enable(ctx);
    ctx.messages.length = 0;
    dispatchKey(ctx.win, ctx.doc, "ArrowDown");
    expect(ctx.messages).toEqual([
      {
        message: { type: "uim:hover-candidate", tag: "h1", text: "サンプルアプリ" },
        targetOrigin: PARENT,
      },
    ]);
    expect(ctx.messages.every((m) => m.targetOrigin !== "*")).toBe(true);
  });

  it("does not steal keys when selection mode is off", () => {
    const ctx = setup(TREE);
    ctx.dispatchParentMessage({ type: "uim:ping" }, PARENT);
    ctx.messages.length = 0;
    for (const k of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter", " ", "Escape"]) {
      expect(dispatchKey(ctx.win, ctx.doc, k).defaultPrevented, k).toBe(false);
    }
    expect(ctx.messages).toEqual([]);
  });

  it("leaves arrow keys to focused text inputs but still handles Escape", () => {
    const ctx = setup(`<input id="in" type="text" /><div id="ce" contenteditable="true">t</div><button id="b">B</button>`);
    enable(ctx);
    for (const id of ["in", "ce"]) {
      const el = ctx.doc.getElementById(id) as HTMLElement;
      el.focus();
      ctx.messages.length = 0;
      for (const k of ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"]) {
        const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        expect(ev.defaultPrevented, `${id} ${k}`).toBe(false);
      }
      expect(ctx.messages).toEqual([]);
      const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
      el.dispatchEvent(esc);
      expect(esc.defaultPrevented).toBe(true);
      expect(types(ctx)).toContain("uim:cancel");
    }
  });

  it("sends nothing from keyboard handling when the parent is untrusted", () => {
    const ctx = setup(TREE);
    ctx.dispatchParentMessage({ type: "uim:setEnabled", value: true }, "http://evil.test");
    ctx.messages.length = 0;
    for (const k of ["ArrowDown", "Enter", "Escape"]) dispatchKey(ctx.win, ctx.doc, k);
    expect(ctx.messages).toEqual([]);
  });

  it("[3] 入力欄では Enter・Space・矢印を奪わず、Esc だけ処理する", () => {
    const ctx = setup(`<textarea id="ta"></textarea><input id="in" /><select id="sel"><option>a</option></select><button id="b">B</button>`);
    enable(ctx);
    for (const id of ["ta", "in", "sel"]) {
      const el = ctx.doc.getElementById(id) as HTMLElement;
      el.focus();
      ctx.messages.length = 0;
      for (const k of ["Enter", " ", "ArrowDown", "ArrowLeft", "Tab"]) {
        const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
        el.dispatchEvent(ev);
        expect(ev.defaultPrevented, `${id} ${k}`).toBe(false);
      }
      expect(ctx.messages).toEqual([]);
    }
  });

  it("[3] IME 変換中は Esc も含め一切奪わない", () => {
    const ctx = setup(TREE);
    enable(ctx);
    ctx.messages.length = 0;
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      for (const k of ["Escape", "Enter", "ArrowDown"]) {
        const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init });
        ctx.doc.body.dispatchEvent(ev);
        expect(ev.defaultPrevented, `${JSON.stringify(init)} ${k}`).toBe(false);
      }
    }
    expect(ctx.messages).toEqual([]);
  });

  it("[3] Shift/Ctrl/Alt/Meta 付きのキーは奪わない", () => {
    const ctx = setup(TREE);
    enable(ctx);
    ctx.messages.length = 0;
    for (const m of ["shiftKey", "ctrlKey", "altKey", "metaKey"]) {
      for (const k of ["ArrowDown", "ArrowRight", "Enter", "Tab", "Escape"]) {
        // Shift+Tab は逆順移動として扱う(別テスト)
        if (m === "shiftKey" && k === "Tab") continue;
        const ev = dispatchKey(ctx.win, ctx.doc, k, { [m]: true });
        expect(ev.defaultPrevented, `${m} ${k}`).toBe(false);
      }
    }
    expect(ctx.messages).toEqual([]);
  });

  describe("open Shadow DOM", () => {
    function shadowSetup() {
      const ctx = setup(`<div id="host"></div><p id="after">after</p>`);
      const host = ctx.doc.getElementById("host") as HTMLElement;
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `<section id="inner"><input id="shin" /></section><span id="inner2">s</span>`;
      Array.from(root.querySelectorAll("*")).forEach(stubVisibleRect);
      return { ctx, host, root };
    }

    it("[4] ↓ でホストから shadowRoot 内の最初の可視子へ降り、↑ でホストへ戻る", () => {
      const { ctx } = shadowSetup();
      enable(ctx); // 初期候補 = host
      dispatchKey(ctx.win, ctx.doc, "ArrowDown");
      dispatchKey(ctx.win, ctx.doc, "Enter");
      expect(lastSelect(ctx)?.payload.id).toBe("inner");
      dispatchKey(ctx.win, ctx.doc, "ArrowUp");
      dispatchKey(ctx.win, ctx.doc, "Enter");
      expect(lastSelect(ctx)?.payload.id).toBe("host");
    });

    it("[4] shadow 内 input にフォーカス中は ←/→ を奪わない", () => {
      const { ctx, root } = shadowSetup();
      enable(ctx);
      const input = root.getElementById("shin") as HTMLElement;
      input.focus();
      ctx.messages.length = 0;
      for (const k of ["ArrowLeft", "ArrowRight", "Enter"]) {
        const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true });
        input.dispatchEvent(ev);
        expect(ev.defaultPrevented, k).toBe(false);
      }
      expect(ctx.messages).toEqual([]);
    });
  });

  it("[5] Tab で候補が変わっても uim:hover-candidate を送る", () => {
    const ctx = setup(`<button id="a">A</button><button id="b">B</button><button id="c">C</button>`);
    enable(ctx);
    ctx.messages.length = 0;
    expect(dispatchKey(ctx.win, ctx.doc, "Tab").defaultPrevented).toBe(true);
    expect(ctx.messages).toEqual([
      { message: { type: "uim:hover-candidate", tag: "button", text: "B" }, targetOrigin: PARENT },
    ]);
    dispatchKey(ctx.win, ctx.doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("b");
  });

  it("Shift+Tab で前の候補に戻り、Shift と他の修飾キーの組み合わせは奪わない", () => {
    const ctx = setup(`<button id="a">A</button><button id="b">B</button><button id="c">C</button>`);
    enable(ctx);
    dispatchKey(ctx.win, ctx.doc, "Tab");
    dispatchKey(ctx.win, ctx.doc, "Tab");
    ctx.messages.length = 0;
    expect(dispatchKey(ctx.win, ctx.doc, "Tab", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(ctx.messages).toEqual([
      { message: { type: "uim:hover-candidate", tag: "button", text: "B" }, targetOrigin: PARENT },
    ]);
    expect(dispatchKey(ctx.win, ctx.doc, "Tab", { shiftKey: true, ctrlKey: true }).defaultPrevented).toBe(false);
    dispatchKey(ctx.win, ctx.doc, "Enter");
    expect(lastSelect(ctx)?.payload.id).toBe("b");
  });

  it("候補テキストの改行・タブは単語区切りとして空白 1 つにする", () => {
    const ctx = setup(`<h1 id="t">foo\nbar\tbaz</h1>`);
    enable(ctx);
    ctx.messages.length = 0;
    ctx.doc.getElementById("t")!.focus();
    dispatchKey(ctx.win, ctx.doc, "ArrowUp");
    dispatchKey(ctx.win, ctx.doc, "Tab");
    const m = ctx.messages.find((x) => (x.message as { type: string }).type === "uim:hover-candidate");
    expect(m?.message).toEqual({ type: "uim:hover-candidate", tag: "h1", text: "foo bar baz" });
  });

  it("候補テキストから ALM・ゼロ幅文字・BOM も除去する", () => {
    const ctx = setup(`<h1 id="t">a\u061Cb\u200Bc\u2060d\uFEFFe</h1>`);
    enable(ctx);
    ctx.messages.length = 0;
    ctx.doc.getElementById("t")!.focus();
    dispatchKey(ctx.win, ctx.doc, "ArrowUp");
    dispatchKey(ctx.win, ctx.doc, "Tab");
    const m = ctx.messages.find((x) => (x.message as { type: string }).type === "uim:hover-candidate");
    expect(m?.message).toEqual({ type: "uim:hover-candidate", tag: "h1", text: "abcde" });
  });

  it("[7] 候補テキストから双方向制御文字・制御文字を除去して送る", () => {
    const ctx = setup(`<h1 id="t">a\u202Eb\u2066c\u200Fd\u0007e\u009Ff</h1>`);
    enable(ctx);
    ctx.messages.length = 0;
    ctx.doc.getElementById("t")!.focus();
    // 初期候補は h1(唯一の body 子)。再度 ↑↓ で通知を発生させる
    dispatchKey(ctx.win, ctx.doc, "ArrowUp");
    dispatchKey(ctx.win, ctx.doc, "Tab");
    const m = ctx.messages.find((x) => (x.message as { type: string }).type === "uim:hover-candidate");
    expect(m?.message).toEqual({ type: "uim:hover-candidate", tag: "h1", text: "abcdef" });
  });
});
