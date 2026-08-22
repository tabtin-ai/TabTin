/**
 * Shadow DOM 穿透页面脚本。
 *
 * 背景：B 站评论区等 Web Components 站点把真实内容放在多层 open shadow root 里，
 * `outerHTML` / `querySelector(All)` / `document.evaluate` 都不跨 shadow 边界，
 * 导致 print 导出缺失、glance 采不到、act 点不动（三条 Agent 主通道同时失效）。
 *
 * 本模块提供两段可注入页面的脚本片段（与 renderer 侧  CONTENT_SNAPSHOT_SNIPPET
 * 同一模式：导出字符串常量，运行时拼进注入脚本，单测直接求值验证语义）：
 *
 * - `SHADOW_DOM_HELPERS_SNIPPET`：深选择器的生成与回解。
 *   深选择器格式 `host >>> inner [>>> ...]`（语义对齐 Playwright 的 pierce 组合器）：
 *   每段在上一段命中元素的 open shadowRoot 内用 `querySelector` 解析；
 *   首段可以是 CSS 或 `xpath=` 绝对路径（xpath 仅在 document 层有效——
 *   `document.evaluate` 本身进不了 shadow，shadow 内段一律用 CSS）。
 * - `DEEP_SERIALIZE_HTML_SNIPPET`：按「扁平树」语义序列化 DOM——
 *   命中 open shadowRoot 时以 shadow 内容替代 light children，slot 处回接
 *   assignedNodes；无 shadow 的页面走 `outerHTML` 快路径，行为与旧版完全一致。
 *
 * closed shadow root 与 iframe 不在本模块能力内（Playwright 同样穿不了 closed）。
 */

/** 深选择器分段分隔符。生成侧保证属性值含此串时不走属性快捷 selector，避免误切分。 */
export const DEEP_SELECTOR_SEPARATOR = ' >>> ';

/** 判断 selector 是否为跨 shadow 的深选择器。 */
export function isDeepSelector(selector: string): boolean {
  return selector.includes(DEEP_SELECTOR_SEPARATOR);
}

/**
 * 深选择器解析 + 生成工具（页面内执行）。定义：
 *
 * - `__tabtinQueryInRoot(root, sel)`：单段解析。root 为 document / shadowRoot / Element；
 *   `xpath=` / `/` 前缀仅在 root === document 时有效。解析失败返回 null（不抛）。
 * - `__tabtinDeepQuery(selector, scopeRoot?)`：按 ` >>> ` 切段逐层下钻 open shadowRoot。
 *   单段输入时行为等价 `__tabtinQueryInRoot`，可作为统一入口。
 * - `__tabtinCollectShadowRoots(start, maxRoots?)`：广度优先收集 start 下（含递归
 *   open shadow）的全部根，返回 `[start, shadowRoot...]`，上限防病态页。
 * - `__tabtinCssPathInRoot(el)`：el 在其所属根内的确定性 CSS 路径
 *   （`tag:nth-of-type(i) > ...`，从所属根的顶层元素起，可被该根的 querySelector 回解）。
 * - `__tabtinSelectorInRoot(el, root)`：根内 selector——短属性 selector（根内唯一）
 *   优先，否则落 nth-of-type 路径。
 * - `__tabtinBuildDeepSelector(el)`：为 shadow 内元素生成 document 级可回解的
 *   深选择器；light DOM 元素返回 null（沿用调用方原有 selector 生成逻辑）。
 */
export const SHADOW_DOM_HELPERS_SNIPPET = `
  function __tabtinQueryInRoot(root, sel) {
    sel = String(sel);
    if (sel.indexOf('xpath=') === 0 || sel.charAt(0) === '/') {
      if (root !== document) return null;
      var xp = sel.indexOf('xpath=') === 0 ? sel.slice(6) : sel;
      try {
        var r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return r.singleNodeValue;
      } catch (e) { return null; }
    }
    try { return root.querySelector(sel); } catch (e) { return null; }
  }
  function __tabtinDeepQuery(selector, scopeRoot) {
    var parts = String(selector).split(' >>> ');
    var root = scopeRoot || document;
    var el = null;
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (!part) return null;
      el = __tabtinQueryInRoot(root, part);
      if (!el) return null;
      if (i < parts.length - 1) {
        if (!el.shadowRoot) return null;
        root = el.shadowRoot;
      }
    }
    return el;
  }
  function __tabtinCollectShadowRoots(start, maxRoots) {
    var cap = maxRoots || 256;
    var roots = [start];
    for (var i = 0; i < roots.length && roots.length < cap; i += 1) {
      var all;
      try { all = roots[i].querySelectorAll('*'); } catch (e) { continue; }
      for (var j = 0; j < all.length && roots.length < cap; j += 1) {
        if (all[j].shadowRoot) roots.push(all[j].shadowRoot);
      }
    }
    return roots;
  }
  function __tabtinCssPathInRoot(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var t = node.localName;
      var idx = 1;
      var sib = node.previousElementSibling;
      while (sib) { if (sib.localName === t) idx += 1; sib = sib.previousElementSibling; }
      parts.unshift(t + ':nth-of-type(' + idx + ')');
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function __tabtinSelectorInRoot(el, root) {
    var uniq = function (sel) {
      try { return root.querySelectorAll(sel).length === 1 ? sel : null; } catch (e) { return null; }
    };
    var usable = function (v) { return v && String(v).indexOf(' >>> ') === -1; };
    var tag = el.localName;
    var sel = null;
    if (usable(el.id)) sel = uniq('#' + CSS.escape(el.id));
    var testid = el.getAttribute && el.getAttribute('data-testid');
    if (!sel && usable(testid)) sel = uniq('[data-testid=' + JSON.stringify(testid) + ']');
    var ariaLabel = el.getAttribute && el.getAttribute('aria-label');
    if (!sel && usable(ariaLabel)) sel = uniq(tag + '[aria-label=' + JSON.stringify(ariaLabel) + ']');
    return sel || __tabtinCssPathInRoot(el);
  }
  function __tabtinBuildDeepSelector(el) {
    var chain = [];
    var node = el;
    for (var guard = 0; guard < 64; guard += 1) {
      var root = node.getRootNode ? node.getRootNode() : document;
      if (root && root.host) { chain.unshift(root.host); node = root.host; }
      else break;
    }
    if (chain.length === 0) return null;
    var parts = [];
    for (var i = 0; i < chain.length; i += 1) {
      var hostRoot = i === 0 ? document : chain[i - 1].shadowRoot;
      parts.push(__tabtinSelectorInRoot(chain[i], hostRoot));
    }
    parts.push(__tabtinSelectorInRoot(el, chain[chain.length - 1].shadowRoot));
    return parts.join(' >>> ');
  }
`;

/**
 * 扁平树 HTML 序列化（页面内执行）。定义 `__tabtinDeepHTML(rootEl, opts?)`：
 *
 * - 无 open shadow 的页面：直接返回 `rootEl.outerHTML`（`pierced: false`），零行为差异。
 * - 有 shadow：递归序列化——shadow host 输出 shadow 内容（light children 中未被
 *   slot 分发的部分与用户所见一致地丢弃），`<slot>` 回接 `assignedNodes({flatten})`，
 *   无分发时输出 slot 兜底内容；script/style/noscript 正文按原样（raw text）输出，
 *   与 outerHTML 口径一致，交给下游 cleanHtml / Turndown 过滤。
 * - `opts.maxChars`（默认 20MB 字符）与 `opts.maxDepth`（默认 256）限幅，超限置
 *   `truncated: true`，防病态页拖挂序列化。
 *
 * 返回 `{ html, pierced, truncated }`。
 */
export const DEEP_SERIALIZE_HTML_SNIPPET = `
  function __tabtinDeepHTML(rootEl, opts) {
    var maxDepth = (opts && opts.maxDepth) || 256;
    var maxChars = (opts && opts.maxChars) || 20000000;
    var hasShadow = false;
    try {
      var scan = rootEl.querySelectorAll('*');
      for (var s = 0; s < scan.length; s += 1) {
        if (scan[s].shadowRoot) { hasShadow = true; break; }
      }
      if (!hasShadow && rootEl.shadowRoot) hasShadow = true;
    } catch (e) {}
    if (!hasShadow) return { html: rootEl.outerHTML || '', pierced: false, truncated: false };

    var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1 };
    var RAW_TEXT = { script: 1, style: 1, noscript: 1 };
    var out = [];
    var size = 0;
    var truncated = false;
    var push = function (str) {
      if (truncated) return;
      size += str.length;
      if (size > maxChars) { truncated = true; return; }
      out.push(str);
    };
    var escText = function (str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    };
    var escAttr = function (str) {
      return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    };

    function serializeChildren(node, depth) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i += 1) serializeNode(kids[i], depth);
    }

    function serializeNode(node, depth) {
      if (truncated || depth > maxDepth) return;
      if (node.nodeType === 3) { push(escText(node.textContent)); return; }
      if (node.nodeType === 8) { push('<!--' + String(node.textContent) + '-->'); return; }
      if (node.nodeType !== 1) return;
      var tag = node.localName;
      var open = '<' + tag;
      for (var i = 0; i < node.attributes.length; i += 1) {
        var a = node.attributes[i];
        open += ' ' + a.name + '="' + escAttr(a.value) + '"';
      }
      push(open + '>');
      if (VOID[tag]) return;
      if (RAW_TEXT[tag]) {
        push(String(node.textContent));
      } else if (tag === 'template' && node.content) {
        serializeChildren(node.content, depth + 1);
      } else if (tag === 'slot' && typeof node.assignedNodes === 'function') {
        var assigned = node.assignedNodes({ flatten: true });
        if (assigned.length > 0) {
          for (var k = 0; k < assigned.length; k += 1) serializeNode(assigned[k], depth + 1);
        } else {
          serializeChildren(node, depth + 1);
        }
      } else if (node.shadowRoot) {
        serializeChildren(node.shadowRoot, depth + 1);
      } else {
        serializeChildren(node, depth + 1);
      }
      push('</' + tag + '>');
    }

    serializeNode(rootEl, 0);
    return { html: out.join(''), pierced: true, truncated: truncated };
  }
`;

/**
 * 组装「整页深度序列化取 HTML」表达式，供 print / crawl 注入
 * （替代裸 `document.documentElement.outerHTML`）。
 */
export function buildDeepOuterHTMLExpression(): string {
  return `(() => { ${DEEP_SERIALIZE_HTML_SNIPPET}; return __tabtinDeepHTML(document.documentElement).html; })()`;
}
