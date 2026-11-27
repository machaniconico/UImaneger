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
    expect(dispatchKey(win, doc, "Tab").defaultPrevented).toBe(true);
    expect(dispatchKey(win, doc, "Enter").defaultPrevented).toBe(true);

    expect(messages).toHaveLength(1);
    expect(messages[0].targetOrigin).toBe("http://localhost:5173");
    expect(messages[0].message).toMatchObject({
      type: "uim:select",
      payload: {
        tag: "button",
        id: "second",
        textSnippet: "Second",
      },
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
