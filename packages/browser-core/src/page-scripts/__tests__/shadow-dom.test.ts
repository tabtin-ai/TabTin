// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import {
  SHADOW_DOM_HELPERS_SNIPPET,
  DEEP_SERIALIZE_HTML_SNIPPET,
  isDeepSelector,
  DEEP_SELECTOR_SEPARATOR,
  buildDeepOuterHTMLExpression,
} from '../shadow-dom';

if (typeof (globalThis as any).CSS === 'undefined' || typeof (globalThis as any).CSS.escape !== 'function') {
  (globalThis as any).CSS = {
    ...(globalThis as any).CSS,
    escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, '\\$1'),
  };
}

function loadHelpers() {
  return new Function(`${SHADOW_DOM_HELPERS_SNIPPET}; return {
    deepQuery: __tabtinDeepQuery,
    buildDeep: __tabtinBuildDeepSelector,
    collectRoots: __tabtinCollectShadowRoots,
  };`)() as {
    deepQuery: (sel: string, scope?: ParentNode) => Element | null;
    buildDeep: (el: Element) => string | null;
    collectRoots: (start: ParentNode, max?: number) => ParentNode[];
  };
}

function loadDeepHTML() {
  return new Function(
    `${DEEP_SERIALIZE_HTML_SNIPPET}; return __tabtinDeepHTML;`,
  )() as (
    root: Element,
    opts?: { maxChars?: number; maxDepth?: number },
  ) => { html: string; pierced: boolean; truncated: boolean };
}

describe('isDeepSelector', () => {
  it('识别分隔符', () => {
    expect(isDeepSelector(`host${DEEP_SELECTOR_SEPARATOR}button`)).toBe(true);
    expect(isDeepSelector('#x')).toBe(false);
  });
});

describe('deep query / build（多层 open shadow）', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('往返：BuildDeepSelector → DeepQuery 命中同一按钮', () => {
    const host = document.createElement('bili-comments');
    host.id = 'comments-host';
    const s1 = host.attachShadow({ mode: 'open' });
    const thread = document.createElement('bili-thread');
    const s2 = thread.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '点赞');
    btn.textContent = '赞';
    s2.appendChild(btn);
    s1.appendChild(thread);
    document.body.appendChild(host);

    const { deepQuery, buildDeep } = loadHelpers();
    const sel = buildDeep(btn);
    expect(sel).toBeTruthy();
    expect(sel!).toContain(DEEP_SELECTOR_SEPARATOR);
    expect(deepQuery(sel!)).toBe(btn);
  });

  it('light DOM 元素 BuildDeepSelector 返回 null', () => {
    const btn = document.createElement('button');
    btn.id = 'plain';
    document.body.appendChild(btn);
    expect(loadHelpers().buildDeep(btn)).toBeNull();
  });

  it('CollectShadowRoots 含 document 与嵌套 shadowRoot', () => {
    const host = document.createElement('x-host');
    const root = host.attachShadow({ mode: 'open' });
    root.appendChild(document.createElement('span'));
    document.body.appendChild(host);
    const roots = loadHelpers().collectRoots(document);
    expect(roots[0]).toBe(document);
    expect(roots).toContain(root);
  });
});

describe('DeepHTML', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('无 shadow：pierced=false 且 html === outerHTML', () => {
    document.body.innerHTML = '<main><p>hello</p></main>';
    const r = loadDeepHTML()(document.documentElement);
    expect(r.pierced).toBe(false);
    expect(r.truncated).toBe(false);
    expect(r.html).toBe(document.documentElement.outerHTML);
  });

  it('多层 open shadow：html 含内层文本', () => {
    const host = document.createElement('bili-comments');
    const s1 = host.attachShadow({ mode: 'open' });
    const inner = document.createElement('bili-thread');
    const s2 = inner.attachShadow({ mode: 'open' });
    const p = document.createElement('p');
    p.textContent = '第一条评论';
    s2.appendChild(p);
    s1.appendChild(inner);
    document.body.appendChild(host);

    const r = loadDeepHTML()(document.documentElement);
    expect(r.pierced).toBe(true);
    expect(r.html).toContain('第一条评论');
  });

  it('slot 用 assignedNodes 扁平回接', () => {
    const host = document.createElement('x-card');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(document.createElement('slot'));
    const span = document.createElement('span');
    span.textContent = '投影文本';
    host.appendChild(span);
    document.body.appendChild(host);

    const r = loadDeepHTML()(host);
    expect(r.pierced).toBe(true);
    expect(r.html).toContain('投影文本');
  });

  it('maxChars 截断置 truncated', () => {
    const host = document.createElement('x-big');
    const shadow = host.attachShadow({ mode: 'open' });
    const p = document.createElement('p');
    p.textContent = '很长'.repeat(200);
    shadow.appendChild(p);
    document.body.appendChild(host);
    const r = loadDeepHTML()(host, { maxChars: 40 });
    expect(r.truncated).toBe(true);
    expect(r.html.length).toBeLessThanOrEqual(40);
  });
});

describe('buildDeepOuterHTMLExpression', () => {
  it('表达式求值返回字符串 HTML', () => {
    document.body.innerHTML = '<p>x</p>';
    // eslint-disable-next-line no-eval
    const html = eval(buildDeepOuterHTMLExpression()) as string;
    expect(typeof html).toBe('string');
    expect(html).toContain('<p>x</p>');
  });
});
