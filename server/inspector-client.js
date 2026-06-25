/* UImaneger inspector — 対象ページに注入される。プレーンJS。
   - ホバーで要素をハイライト(スクロール/リサイズに追従)
   - クリックで DOM ディスクリプタ(言語非依存) を親へ postMessage
   - 層Aアダプタ: React fiber._debugSource / Vue __vueParentComponent,__vue__ /
     Svelte __svelte* メタ / 汎用 data-* ヒント を descriptor に付与
   - payload は後方互換(tag,id,classes,attrs,textSnippet,domPath,source?)を維持し、
     追加情報は vue/svelte/hints の任意フィールドで拡張
   - 親からの CSS プレビュー注入(層C)/選択モード切替を受ける
*/
(function () {
  if (window.__uimInspectorLoaded) return;
  window.__uimInspectorLoaded = true;

  var enabled = false;
  var overlay = null;
  var styleEl = null;
  var currentEl = null;
  var rafPending = false;

  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #4f8cff;" +
      "background:rgba(79,140,255,.12);border-radius:3px;transition:all .04s ease;display:none;";
    document.documentElement.appendChild(overlay);
    return overlay;
  }

  function moveOverlay(el) {
    var o = ensureOverlay();
    var r = el.getBoundingClientRect();
    o.style.display = "block";
    o.style.left = r.left + "px";
    o.style.top = r.top + "px";
    o.style.width = r.width + "px";
    o.style.height = r.height + "px";
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = "none";
  }

  // --- 層A: React fiber から source を辿る ---
  function getReactSource(node) {
    var key = Object.keys(node).find(function (k) {
      return (
        k.indexOf("__reactFiber$") === 0 ||
        k.indexOf("__reactInternalInstance$") === 0
      );
    });
    if (!key) return null;
    var fiber = node[key];
    while (fiber) {
      if (fiber._debugSource) {
        return {
          fileName: fiber._debugSource.fileName,
          lineNumber: fiber._debugSource.lineNumber,
          columnNumber: fiber._debugSource.columnNumber,
        };
      }
      fiber = fiber.return;
    }
    return null;
  }

  // props を JSON-safe なプリミティブ値だけに縮約する。
  // (関数/Proxy/循環参照を postMessage(structuredClone) に渡すと送信全体が失敗するため)
  function safeProps(props) {
    if (!props || typeof props !== "object") return undefined;
    var out = {};
    var n = 0;
    for (var k in props) {
      if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
      var v;
      try {
        v = props[k];
      } catch (e) {
        continue;
      }
      var t = typeof v;
      if (v == null || t === "string" || t === "number" || t === "boolean") {
        out[k] = v;
        if (++n >= 20) break;
      }
    }
    return n ? out : undefined;
  }

  // --- 層A: Vue component 情報 (補助) ---
  // Vue3: __vueParentComponent (VNode) / Vue2: __vue__ (instance)
  // source 解決は層B任せ。ここでは component 名・props を補助情報として付与。
  function getVueInfo(node) {
    var keys = Object.keys(node);
    var key3 = keys.find(function (k) {
      return k.indexOf("__vueParentComponent") === 0;
    });
    if (key3) {
      try {
        var comp = node[key3];
        var type = (comp && comp.type) || null;
        var name = (type && (type.name || type.__name)) || null;
        var props = comp && comp.props ? safeProps(comp.props) : undefined;
        if (name) {
          return { framework: "vue3", name: name, props: props };
        }
      } catch (e) {}
      return null;
    }
    var key2 = keys.find(function (k) {
      return k.indexOf("__vue__") === 0;
    });
    if (key2) {
      try {
        var inst = node[key2];
        var opts = (inst && inst.$options) || null;
        var name = (opts && (opts.name || opts._componentTag)) || null;
        var rawProps =
          (inst && inst.$props) || (opts && opts.propsData) || null;
        var props = safeProps(rawProps);
        if (name) {
          return { framework: "vue2", name: name, props: props };
        }
      } catch (e) {}
      return null;
    }
    return null;
  }

  // --- 層A: Svelte メタ (補助) ---
  // __svelte_meta 等があれば start.{file,line,column} を補助情報として付与。
  function getSvelteInfo(node) {
    var key = Object.keys(node).find(function (k) {
      return k.indexOf("__svelte") === 0;
    });
    if (!key) return null;
    try {
      var meta = node[key];
      var start = meta && meta.start;
      if (start && (start.file != null || start.line != null)) {
        return {
          framework: "svelte",
          source: {
            fileName: start.file != null ? start.file : undefined,
            lineNumber: start.line != null ? start.line + 1 : undefined,
            columnNumber: start.column != null ? start.column + 1 : undefined,
          },
        };
      }
    } catch (e) {}
    return null;
  }

  // --- 汎用: data-* ヒント属性 (source ヒント) ---
  function getHints(el) {
    var names = [
      "data-testid",
      "data-component",
      "data-source",
      "data-test",
      "data-cy",
    ];
    var hints = {};
    for (var i = 0; i < names.length; i++) {
      if (el.hasAttribute(names[i])) {
        hints[names[i]] = el.getAttribute(names[i]);
      }
    }
    return Object.keys(hints).length ? hints : null;
  }

  function cssPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      var sel = node.nodeName.toLowerCase();
      if (node.id) {
        sel = "#" + node.id;
        parts.unshift(sel);
        break;
      }
      var parent = node.parentNode;
      if (parent) {
        var sibs = Array.prototype.filter.call(parent.children, function (c) {
          return c.nodeName === node.nodeName;
        });
        if (sibs.length > 1) {
          sel += ":nth-of-type(" + (sibs.indexOf(node) + 1) + ")";
        }
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(" > ");
  }

  function describe(el) {
    var attrs = {};
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      if (a.name === "style") continue;
      attrs[a.name] = a.value;
    }
    var r = el.getBoundingClientRect();
    var text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120);
    var vue = getVueInfo(el);
    var svelte = getSvelteInfo(el);
    var hints = getHints(el);
    var d = {
      tag: el.nodeName.toLowerCase(),
      id: el.id || undefined,
      classes: el.className && typeof el.className === "string"
        ? el.className.split(/\s+/).filter(Boolean)
        : [],
      attrs: attrs,
      textSnippet: text || undefined,
      domPath: cssPath(el),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      // 層A: React を最優先、無ければ Svelte の source を昇格 (resolver は d.source を見る)
      source: getReactSource(el) || (svelte && svelte.source) || undefined,
    };
    if (vue) d.vue = vue;
    if (svelte) d.svelte = svelte;
    if (hints) d.hints = hints;
    return d;
  }

  function onMove(e) {
    if (!enabled) return;
    var el = e.target;
    if (!el || el === overlay) return;
    currentEl = el;
    moveOverlay(el);
  }

  function onClick(e) {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    var el = e.target;
    if (!el || el === overlay) return;
    var payload = describe(el);
    window.parent.postMessage({ type: "uim:select", payload: payload }, "*");
    return false;
  }

  function setEnabled(v) {
    enabled = v;
    document.documentElement.style.cursor = v ? "crosshair" : "";
    if (!v) hideOverlay();
  }

  // 層C: 親から渡された CSS を即時注入してプレビュー
  function applyPreviewCss(css) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "uim-preview-style";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css || "";
  }

  // スクロール/リサイズ時にオーバーレイが要素へ追従するよう再位置決め
  function scheduleOverlayFollow() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (!enabled || !currentEl || !document.body.contains(currentEl)) {
        hideOverlay();
        return;
      }
      moveOverlay(currentEl);
    });
  }

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("scroll", scheduleOverlayFollow, true);
  window.addEventListener("resize", scheduleOverlayFollow);

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "uim:setEnabled") setEnabled(!!d.value);
    else if (d.type === "uim:previewCss") applyPreviewCss(d.css);
    else if (d.type === "uim:ping")
      window.parent.postMessage({ type: "uim:pong" }, "*");
  });

  // 起動通知
  window.parent.postMessage({ type: "uim:ready" }, "*");
})();
