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
  var resizeObs = null;
  var trustedParentOrigin = null;
  var readySent = false;

  // プレビューを埋め込める親(UI)の origin。プロキシが配信時に JSON 配列で埋め込む
  // (埋め込まれていなければ空 = どの親も信頼しない)。
  var PARENT_ORIGINS = /*__UIM_PARENT_ORIGINS__*/ [];

  function isTrustedOrigin(o) {
    return typeof o === "string" && PARENT_ORIGINS.indexOf(o) !== -1;
  }

  function postToParent(message) {
    if (!trustedParentOrigin) return false;
    window.parent.postMessage(message, trustedParentOrigin);
    return true;
  }

  function sendReady() {
    if (readySent) return;
    if (postToParent({ type: "uim:ready" })) readySent = true;
  }

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

  // className が文字列でない(SVGAnimatedString 等)場合もクラス列を取り出す。
  // SVG 要素は className.baseVal、それ以外は classList からフォールバック。
  function getClasses(el) {
    try {
      var cn = el.className;
      if (cn == null) return [];
      if (typeof cn === "object" && cn.baseVal != null) cn = cn.baseVal;
      if (typeof cn !== "string") {
        if (el.classList && el.classList.length) {
          return Array.prototype.slice.call(el.classList);
        }
        return [];
      }
      return cn.split(/\s+/).filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  function textWithBoundaries(el) {
    var s = "";
    if (!el || !el.childNodes) return s;
    el.childNodes.forEach(function (n) {
      s +=
        n.nodeType === 3
          ? n.textContent || ""
          : " " + textWithBoundaries(n) + " ";
    });
    return s;
  }

  // 層A含め全て失敗した時の DOM のみ最小 descriptor (payload 互換性を維持)
  function minimalDescriptor(el) {
    try {
      var r = el.getBoundingClientRect();
      var text = textWithBoundaries(el).trim().replace(/\s+/g, " ").slice(0, 120);
      return {
        tag: el.nodeName.toLowerCase(),
        id: el.id || undefined,
        classes: getClasses(el),
        attrs: {},
        textSnippet: text || undefined,
        domPath: cssPath(el),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        source: undefined,
      };
    } catch (e2) {
      return {
        tag: el && el.nodeName ? el.nodeName.toLowerCase() : "unknown",
        id: undefined,
        classes: [],
        attrs: {},
        textSnippet: undefined,
        domPath: "",
        source: undefined,
      };
    }
  }

  function describe(el) {
    try {
      var attrs = {};
      for (var i = 0; i < el.attributes.length; i++) {
        var a = el.attributes[i];
        if (a.name === "style") continue;
        attrs[a.name] = a.value;
      }
      var r = el.getBoundingClientRect();
      var text = textWithBoundaries(el).trim().replace(/\s+/g, " ").slice(0, 120);
      // 層A取得は個別に try/catch — 1つ失敗しても DOM 情報は生かす
      var vue, svelte, hints, source;
      try { vue = getVueInfo(el); } catch (e) {}
      try { svelte = getSvelteInfo(el); } catch (e) {}
      try { hints = getHints(el); } catch (e) {}
      try {
        source = getReactSource(el) || (svelte && svelte.source) || undefined;
      } catch (e) {
        source = undefined;
      }
      var d = {
        tag: el.nodeName.toLowerCase(),
        id: el.id || undefined,
        classes: getClasses(el),
        attrs: attrs,
        textSnippet: text || undefined,
        domPath: cssPath(el),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
        // 層A: React を最優先、無ければ Svelte の source を昇格 (resolver は d.source を見る)
        source: source,
      };
      if (vue) d.vue = vue;
      if (svelte) d.svelte = svelte;
      if (hints) d.hints = hints;
      return d;
    } catch (e) {
      // 層A含め全て失敗 → DOM 情報だけで最小 descriptor を返す
      return minimalDescriptor(el);
    }
  }

  // 選択中要素のサイズ変化を ResizeObserver で追従 (previewCss 注入等のレイアウト変化)
  function observeCurrent(el) {
    if (resizeObs) {
      try { resizeObs.disconnect(); } catch (e) {}
      resizeObs = null;
    }
    if (!el || typeof ResizeObserver === "undefined") return;
    try {
      resizeObs = new ResizeObserver(function () { scheduleOverlayFollow(); });
      resizeObs.observe(el);
    } catch (e) {}
  }

  function setCurrentEl(el) {
    if (currentEl === el) return;
    currentEl = el;
    observeCurrent(el);
  }

  function isFocusableElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.disabled) return false;
    if (el.hasAttribute("tabindex")) {
      var tabIndex = parseInt(el.getAttribute("tabindex") || "", 10);
      return !isNaN(tabIndex) && tabIndex >= 0;
    }
    var tag = el.nodeName.toLowerCase();
    if (tag === "a" || tag === "area") return !!el.getAttribute("href");
    return (
      tag === "button" ||
      tag === "input" ||
      tag === "select" ||
      tag === "textarea" ||
      tag === "summary" ||
      tag === "iframe" ||
      tag === "object" ||
      tag === "embed" ||
      tag === "video" ||
      tag === "audio" ||
      el.hasAttribute("contenteditable")
    );
  }

  function hasVisibleBox(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return true;
      if (typeof el.getClientRects === "function" && el.getClientRects().length) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function isKeyboardCandidate(el) {
    if (!el || el.nodeType !== 1 || el === overlay || !el.isConnected) return false;
    var tag = el.nodeName.toLowerCase();
    if (
      tag === "script" ||
      tag === "style" ||
      tag === "link" ||
      tag === "meta" ||
      tag === "title" ||
      tag === "noscript" ||
      tag === "template"
    ) {
      return false;
    }
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") {
      return false;
    }
    try {
      if (window.getComputedStyle) {
        var style = window.getComputedStyle(el);
        if (
          style &&
          (style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse")
        ) {
          return false;
        }
      }
    } catch (e) {}
    return hasVisibleBox(el) || isFocusableElement(el);
  }

  function getKeyboardCandidates() {
    if (!document.body) return [];
    var selector = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "iframe",
      "object",
      "embed",
      "video",
      "audio",
      "[tabindex]",
      "[role]",
      "[contenteditable]",
      "[data-testid]",
      "[data-component]",
      "[data-test]",
      "[data-cy]",
      "main",
      "header",
      "nav",
      "section",
      "article",
      "aside",
      "footer",
      "form",
      "div",
      "p",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "label",
      "img",
      "svg",
      "canvas",
    ].join(",");
    var out = [];
    function collect(root) {
      var matches = root.querySelectorAll(selector);
      for (var i = 0; i < matches.length; i++) {
        if (isKeyboardCandidate(matches[i])) out.push(matches[i]);
      }
      var elements = root.querySelectorAll("*");
      for (var j = 0; j < elements.length; j++) {
        if (elements[j].shadowRoot) collect(elements[j].shadowRoot);
      }
    }
    collect(document.body);
    return out;
  }

  function revealKeyboardCandidate(el) {
    try {
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    } catch (e) {
      try {
        el.scrollIntoView();
      } catch (e2) {}
    }
  }

  function moveKeyboardSelection(delta) {
    var candidates = getKeyboardCandidates();
    if (!candidates.length) {
      setCurrentEl(null);
      hideOverlay();
      return;
    }
    var index = currentEl ? candidates.indexOf(currentEl) : -1;
    if (index < 0) index = delta < 0 ? 0 : -1;
    var nextIndex = (index + delta + candidates.length) % candidates.length;
    var next = candidates[nextIndex];
    focusCandidate(next);
  }

  function selectElement(el) {
    if (!el || el === overlay) return false;
    try {
      var payload = describe(el);
      return postToParent({ type: "uim:select", payload: payload });
    } catch (e) {
      // describe/postMessage が投げても選択イベントごと失われないよう握る
      return false;
    }
  }

  function eventElement(e) {
    try {
      var path = typeof e.composedPath === "function" ? e.composedPath() : [];
      for (var i = 0; i < path.length; i++) {
        var node = path[i];
        if (node && node.nodeType === 1 && node !== overlay) return node;
      }
    } catch (err) {}
    var target = e && e.target;
    return target && target.nodeType === 1 && target !== overlay ? target : null;
  }

  function onMove(e) {
    if (!enabled) return;
    var el = eventElement(e);
    if (!el || el === overlay) return;
    setCurrentEl(el);
    // rAF スロットル: mousemove 毎の getBoundingClientRect(強制レイアウト)を防ぐ
    scheduleOverlayFollow();
  }

  function onClick(e) {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    selectElement(eventElement(e));
    return false;
  }

  // --- キーボード: ツリー移動(↑親 ↓最初の子 ←→前後の兄弟) ---
  function isTreeNode(el) {
    var tag = el && el.nodeName ? el.nodeName.toLowerCase() : "";
    return tag !== "html" && tag !== "body" && isKeyboardCandidate(el);
  }

  function siblingCandidate(el, dir) {
    var n = dir > 0 ? el.nextElementSibling : el.previousElementSibling;
    while (n && !isTreeNode(n)) {
      n = dir > 0 ? n.nextElementSibling : n.previousElementSibling;
    }
    return n;
  }

  function firstVisibleChild(parent) {
    var n = parent.firstElementChild;
    while (n && !isTreeNode(n)) n = n.nextElementSibling;
    return n;
  }

  // open shadowRoot があればその最初の可視子へ、なければ通常の子へ降りる
  function firstChildCandidate(el) {
    if (el.shadowRoot) {
      var inner = firstVisibleChild(el.shadowRoot);
      if (inner) return inner;
    }
    return firstVisibleChild(el);
  }

  // shadowRoot の最上位からはホストへ上がる
  function parentOf(n) {
    if (n.parentElement) return n.parentElement;
    var root = n.getRootNode ? n.getRootNode() : null;
    return root && root.host ? root.host : null;
  }

  function parentCandidate(el) {
    var n = parentOf(el);
    while (n && !isTreeNode(n)) n = parentOf(n);
    return n;
  }

  function deepActiveElement() {
    var a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) {
      a = a.shadowRoot.activeElement;
    }
    return a;
  }

  function initialCandidate() {
    var active = deepActiveElement();
    if (active && active !== document.body && isTreeNode(active)) return active;
    return document.body ? firstChildCandidate(document.body) : null;
  }

  function describeCandidate(el) {
    var text = textWithBoundaries(el)
      // 制御文字・双方向制御文字・不可視文字は読み上げ領域に混ぜない(\s は U+FEFF にも一致するので空白の正規化より先に除く。改行・タブは単語区切りなので残して空白に正規化する)
      .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return { tag: el.nodeName.toLowerCase(), text: text.slice(0, 60) };
  }

  function focusCandidate(el) {
    if (!el) return;
    setCurrentEl(el);
    revealKeyboardCandidate(el);
    scheduleOverlayFollow();
    var d = describeCandidate(el);
    postToParent({ type: "uim:hover-candidate", tag: d.tag, text: d.text });
  }

  function isEditableTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = el.nodeName.toLowerCase();
    return (
      tag === "input" ||
      tag === "textarea" ||
      tag === "select" ||
      el.isContentEditable === true ||
      el.getAttribute("contenteditable") === "" ||
      el.getAttribute("contenteditable") === "true"
    );
  }

  function onKeyDown(e) {
    if (!enabled) return;
    // IME 変換中・修飾キー付き(Shift+矢印の文字選択など)はページ本来の操作
    if (e.isComposing || e.keyCode === 229) return;
    // Shift+Tab(逆順移動)だけは例外。それ以外の修飾キー付き(Shift+矢印の文字選択など)は奪わない
    var shiftTab = e.key === "Tab" && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey;
    if (!shiftTab && (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey)) return;

    var key = e.key;
    var realTarget = e.target;
    try {
      var path = typeof e.composedPath === "function" ? e.composedPath() : [];
      if (path.length && path[0] && path[0].nodeType === 1) realTarget = path[0];
    } catch (err) {}
    var editing = isEditableTarget(realTarget) || isEditableTarget(deepActiveElement());
    var handled = false;
    if (key === "Escape") {
      handled = true;
      setCurrentEl(null);
      hideOverlay();
      postToParent({ type: "uim:cancel" });
    } else if (editing) {
      // 入力欄ではタイピング・カーソル移動・確定キーを奪わない
      return;
    } else if (
      key === "ArrowUp" ||
      key === "ArrowDown" ||
      key === "ArrowLeft" ||
      key === "ArrowRight"
    ) {
      handled = true;
      if (!currentEl || !currentEl.isConnected) {
        focusCandidate(initialCandidate());
      } else {
        var next =
          key === "ArrowUp"
            ? parentCandidate(currentEl)
            : key === "ArrowDown"
            ? firstChildCandidate(currentEl)
            : siblingCandidate(currentEl, key === "ArrowLeft" ? -1 : 1);
        if (next) focusCandidate(next);
      }
    } else if (key === "Tab") {
      handled = true;
      moveKeyboardSelection(shiftTab ? -1 : 1);
    } else if (key === "Enter" || key === " " || key === "Spacebar") {
      handled = true;
      if (currentEl && currentEl.isConnected) selectElement(currentEl);
    }

    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function setEnabled(v) {
    var was = enabled;
    enabled = v;
    document.documentElement.style.cursor = v ? "crosshair" : "";
    if (!v) {
      hideOverlay();
      observeCurrent(null);
      currentEl = null;
    } else if (!was) {
      // 選択モード開始時の初期候補(親は 1 秒ごとに再送するので遷移時だけ)
      focusCandidate(initialCandidate());
    }
  }

  // 層C: 親から渡された CSS を即時注入してプレビュー
  function applyPreviewCss(css) {
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "uim-preview-style";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = css || "";
    // CSS 注入でレイアウトが変わるとオーバーレイ位置がずれるため
    // レイアウト反映後に再位置決め (二段 rAF)
    scheduleOverlayFollow();
    requestAnimationFrame(function () {
      scheduleOverlayFollow();
    });
  }

  // スクロール/リサイズ時にオーバーレイが要素へ追従するよう再位置決め
  function scheduleOverlayFollow() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      if (!enabled || !currentEl || !currentEl.isConnected) {
        hideOverlay();
        observeCurrent(null);
        return;
      }
      moveOverlay(currentEl);
    });
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      isTrustedOrigin: isTrustedOrigin,
      safeProps: safeProps,
      cssPath: cssPath,
      getClasses: getClasses,
      textWithBoundaries: textWithBoundaries,
      minimalDescriptor: minimalDescriptor,
      describe: describe,
      isKeyboardCandidate: isKeyboardCandidate,
      getKeyboardCandidates: getKeyboardCandidates,
      eventElement: eventElement,
    };
  }

  // このスクリプトは注入された被プレビュー文書だけを inspect 対象にする。
  // ネストした同一 origin iframe からの選択イベントは relay しない。
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", scheduleOverlayFollow, true);
  window.addEventListener("resize", scheduleOverlayFollow);

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    if (!isTrustedOrigin(e.origin)) return;
    if (trustedParentOrigin && e.origin !== trustedParentOrigin) return;
    trustedParentOrigin = e.origin;
    sendReady();
    var d = e.data || {};
    if (d.type === "uim:setEnabled") setEnabled(!!d.value);
    else if (d.type === "uim:previewCss") applyPreviewCss(d.css);
    else if (d.type === "uim:ping")
      postToParent({ type: "uim:pong" });
  });

  // 起動通知
  sendReady();
})();
