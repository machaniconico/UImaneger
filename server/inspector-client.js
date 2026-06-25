/* UImaneger inspector — 対象ページに注入される。プレーンJS。
   - ホバーで要素をハイライト
   - クリックで DOM ディスクリプタ(言語非依存) を親へ postMessage
   - React があれば fiber._debugSource を source に詰める (層A)
   - 親からの CSS プレビュー注入(層C)/選択モード切替を受ける
*/
(function () {
  if (window.__uimInspectorLoaded) return;
  window.__uimInspectorLoaded = true;

  var enabled = false;
  var overlay = null;
  var styleEl = null;

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
    return {
      tag: el.nodeName.toLowerCase(),
      id: el.id || undefined,
      classes: el.className && typeof el.className === "string"
        ? el.className.split(/\s+/).filter(Boolean)
        : [],
      attrs: attrs,
      textSnippet: text || undefined,
      domPath: cssPath(el),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      source: getReactSource(el) || undefined,
    };
  }

  function onMove(e) {
    if (!enabled) return;
    var el = e.target;
    if (!el || el === overlay) return;
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

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  window.addEventListener("scroll", hideOverlay, true);

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
