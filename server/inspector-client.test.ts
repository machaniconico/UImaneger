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
  parentOrigin: () => string;
  safeProps: (props: unknown) => Record<string, unknown> | undefined;
  describe: (el: Element) => InspectorPayload;
}

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const inspectorSource = readFileSync(
  join(__dirname, "inspector-client.js"),
  "utf8"
);

function loadInspector(referrer = "https://editor.example/projects/1"): {
  helpers: InspectorHelpers;
  messages: PostedMessage[];
} {
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete (window as typeof window & { __uimInspectorLoaded?: boolean })
    .__uimInspectorLoaded;
  Object.defineProperty(document, "referrer", {
    configurable: true,
    value: referrer,
  });

  const messages: PostedMessage[] = [];
  const parentWindow = window.parent as Window & {
    postMessage: (message: unknown, targetOrigin: string) => void;
  };
  parentWindow.postMessage = (message: unknown, targetOrigin: string) => {
    messages.push({ message, targetOrigin });
  };

  const module = { exports: {} };
  const context = vm.createContext({
    window,
    document,
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
  };
}

describe("inspector-client helpers", () => {
  it("keeps the selected element payload backward-compatible", () => {
    const { helpers } = loadInspector();
    document.body.innerHTML = `
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

    const el = document.querySelector("button");
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

  it("derives a stable parent origin from document.referrer", () => {
    const { helpers, messages } = loadInspector(
      "https://editor.example/projects/1?preview=1"
    );

    expect(helpers.parentOrigin()).toBe("https://editor.example");
    expect(messages[0]).toEqual({
      message: { type: "uim:ready" },
      targetOrigin: "https://editor.example",
    });
  });
});
