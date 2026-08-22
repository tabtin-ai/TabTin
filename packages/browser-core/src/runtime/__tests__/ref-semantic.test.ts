// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  assignSemanticFingerprints,
  buildSemanticRelocateScript,
  effectiveSemanticRole,
  formatSemanticRelocateFailure,
  isStaleLocatorError,
  normalizeSemanticName,
  type SemanticFingerprint,
} from '../ref-semantic';
import { DEEP_SELECTOR_SEPARATOR, SHADOW_DOM_HELPERS_SNIPPET } from '../../page-scripts/shadow-dom';

if (typeof (globalThis as any).CSS === 'undefined' || typeof (globalThis as any).CSS.escape !== 'function') {
  (globalThis as any).CSS = {
    ...(globalThis as any).CSS,
    escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, '\\$1'),
  };
}

function loadDeepQuery() {
  return new Function(`${SHADOW_DOM_HELPERS_SNIPPET}; return __tabtinDeepQuery;`)() as (
    sel: string,
  ) => Element | null;
}

/** 解析 relocate 产出的 selector（含 xpath= / deep），供断言回解到目标节点。 */
function resolveRelocateSelector(selector: string): Element | null {
  if (selector.startsWith('xpath=')) {
    const xpath = selector.slice('xpath='.length);
    return document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue as Element | null;
  }
  if (selector.includes(DEEP_SELECTOR_SEPARATOR)) {
    return loadDeepQuery()(selector);
  }
  return document.querySelector(selector);
}

function runRelocateScript(fp: SemanticFingerprint) {
  const script = buildSemanticRelocateScript(fp).trim();
  // buildSemanticRelocateScript 产出 IIFE 语句，在 jsdom document 上直接 eval。
  // eslint-disable-next-line no-eval
  return eval(script) as {
    success: boolean;
    selector?: string;
    code?: string;
    error?: string;
  };
}

describe('ref-semantic.assignSemanticFingerprints', () => {
  it('同名同 role 元素按 snapshot 顺序分配 nth', () => {
    const fps = assignSemanticFingerprints([
      { tag: 'a', role: 'link', name: 'News' },
      { tag: 'a', role: 'link', name: 'News' },
      { tag: 'button', name: 'Go' },
    ]);
    expect(fps[0]).toEqual({ role: 'link', name: 'News', nth: 0 });
    expect(fps[1]).toEqual({ role: 'link', name: 'News', nth: 1 });
    expect(fps[2]).toEqual({ role: 'button', name: 'Go', nth: 0 });
  });

  it('tag-only 元素用默认 a11y role', () => {
    expect(effectiveSemanticRole(undefined, 'a')).toBe('link');
    expect(effectiveSemanticRole(undefined, 'button')).toBe('button');
  });

  it('name 统一 trim + 60 字符归一化', () => {
    const raw = `  ${'Long semantic label '.repeat(5)}  `;
    const expected = raw.trim().slice(0, 60);
    expect(normalizeSemanticName(raw)).toBe(expected);
    expect(assignSemanticFingerprints([{ tag: 'button', name: raw }])[0]).toEqual({
      role: 'button',
      name: expected,
      nth: 0,
    });
  });
});

describe('ref-semantic.isStaleLocatorError', () => {
  it('只把元素找不到视为可语义重定位的 stale', () => {
    expect(isStaleLocatorError('element_not_found')).toBe(true);
    expect(isStaleLocatorError('cdp_error', 'Element not found or not visible: xpath=/old')).toBe(true);
    expect(isStaleLocatorError('selector_evaluation_failed', 'Failed to execute querySelector')).toBe(false);
    expect(isStaleLocatorError('element_not_visible')).toBe(false);
    expect(isStaleLocatorError('element_not_interactable')).toBe(false);
    expect(isStaleLocatorError('cdp_error', 'Input.dispatchMouseEvent failed')).toBe(false);
  });
});

describe('ref-semantic.buildSemanticRelocateScript', () => {
  it('无匹配元素时返回 ref_semantic_relocate_failed', () => {
    document.body.innerHTML = '';
    const result = runRelocateScript({ role: 'link', name: 'Missing', nth: 0 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('ref_semantic_relocate_failed');
  });

  it('按 role/name/nth 命中 DOM 并生成 selector', () => {
    document.body.innerHTML = `
      <nav>
        <a href="/a">Home</a>
        <a href="/b">About</a>
      </nav>
    `;
    const result = runRelocateScript({ role: 'link', name: 'About', nth: 0 });
    expect(result.success).toBe(true);
    expect(result.selector).toBeTruthy();
    const el = resolveRelocateSelector(result.selector!);
    expect(el?.textContent?.trim()).toBe('About');
  });

  it('重复 name 时 nth 选择正确候选', () => {
    document.body.innerHTML = `
      <a href="/1">Dup</a>
      <a href="/2">Dup</a>
    `;
    const result = runRelocateScript({ role: 'link', name: 'Dup', nth: 1 });
    expect(result.success).toBe(true);
    const el = resolveRelocateSelector(result.selector!) as HTMLAnchorElement | null;
    expect(el?.getAttribute('href')).toBe('/2');
  });

  it('JS 挂载 onclick property 的 div（hover 顶导）可被语义重定位——与 observe 采集同口径', () => {
    document.body.innerHTML = `
      <li class="nav-wrapper"><div class="nav-label"><span>创投平台</span></div></li>
      <a href="/home">首页</a>
    `;
    const navLabel = document.querySelector('.nav-label') as HTMLElement;
    navLabel.onclick = () => {};

    // observe 侧指纹：role='' + tag='div' → effectiveSemanticRole 得 'div'
    expect(effectiveSemanticRole('', 'div')).toBe('div');
    const result = runRelocateScript({ role: 'div', name: '创投平台', nth: 0 });
    expect(result.success).toBe(true);
    const el = resolveRelocateSelector(result.selector!);
    expect(el?.textContent?.trim()).toBe('创投平台');
  });

  it('长 name 与 compact snapshot 一样按 60 字符归一化后匹配', () => {
    const longName = 'Open the quarterly planning document with many descriptive suffix words';
    document.body.innerHTML = `<button>${longName}</button>`;
    const result = runRelocateScript({ role: 'button', name: longName.slice(0, 60), nth: 0 });
    expect(result.success).toBe(true);
    const el = resolveRelocateSelector(result.selector!);
    expect(el?.textContent?.trim()).toBe(longName);
  });

  it('shadow 内唯一匹配按钮返回深 selector 且 DeepQuery 回解', () => {
    const host = document.createElement('x-host');
    host.id = 'shadow-host';
    const root = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '点赞');
    btn.textContent = '赞';
    root.appendChild(btn);
    document.body.appendChild(host);

    const result = runRelocateScript({ role: 'button', name: '点赞', nth: 0 });
    expect(result.success).toBe(true);
    expect(result.selector).toContain(DEEP_SELECTOR_SEPARATOR);
    expect(loadDeepQuery()(result.selector!)).toBe(btn);
  });

  it('#7703：分页多个 li>button 时不得产出弱 selector，且回解到目标页码', () => {
    document.body.innerHTML = `
      <ul class="pagination">
        <li><button type="button">1</button></li>
        <li><button type="button">2</button></li>
        <li><button type="button">3</button></li>
      </ul>
    `;
    const result = runRelocateScript({ role: 'button', name: '2', nth: 0 });
    expect(result.success).toBe(true);
    expect(result.selector).toBeTruthy();
    expect(result.selector).not.toBe('li > button');
    expect(result.selector).not.toMatch(/^li\s*>\s*button/);
    // 无唯一 CSS 锚点时应落绝对 xpath（与 SoM  同口径）
    expect(result.selector!.startsWith('xpath=')).toBe(true);

    const el = resolveRelocateSelector(result.selector!);
    expect(el?.tagName.toLowerCase()).toBe('button');
    expect(el?.textContent?.trim()).toBe('2');

    // 弱 selector 会误命中「1」——锁死回归
    const wrongFirst = document.querySelector('li > button');
    expect(wrongFirst?.textContent?.trim()).toBe('1');
    expect(el).not.toBe(wrongFirst);
  });

  it('唯一 aria-label 仍走 CSS 快捷 selector', () => {
    document.body.innerHTML = `
      <button aria-label="唯一提交">Submit</button>
      <button aria-label="取消">Cancel</button>
    `;
    const result = runRelocateScript({ role: 'button', name: '唯一提交', nth: 0 });
    expect(result.success).toBe(true);
    expect(result.selector).toBe('button[aria-label="唯一提交"]');
    expect(resolveRelocateSelector(result.selector!)?.textContent?.trim()).toBe('Submit');
  });

  it('label 包裹的原生 radio 使用关联标签名称完成语义重定位', () => {
    document.body.innerHTML = `
      <label>Large <input type="radio" name="size" value="large"></label>
    `;

    const result = runRelocateScript({ role: 'radio', name: 'Large', nth: 0 });

    expect(result.success).toBe(true);
    const el = resolveRelocateSelector(result.selector!) as HTMLInputElement | null;
    expect(el?.type).toBe('radio');
    expect(el?.value).toBe('large');
  });

  it('原生控件角色优先于冲突的作者 role，与 glance 指纹保持一致', () => {
    document.body.innerHTML = `
      <label>Bacon <input type="checkbox" name="topping" value="bacon" role="button"></label>
    `;

    const result = runRelocateScript({ role: 'checkbox', name: 'Bacon', nth: 0 });

    expect(result.success).toBe(true);
    const el = resolveRelocateSelector(result.selector!) as HTMLInputElement | null;
    expect(el?.type).toBe('checkbox');
    expect(el?.value).toBe('bacon');
  });

  it('input[type=image] 与 glance 一样按原生 button 角色完成语义重定位', () => {
    document.body.innerHTML = `
      <input type="image" aria-label="提交订单" src="/submit.png">
    `;

    const result = runRelocateScript({ role: 'button', name: '提交订单', nth: 0 });

    expect(result.success).toBe(true);
    const el = resolveRelocateSelector(result.selector!) as HTMLInputElement | null;
    expect(el?.type).toBe('image');
  });
});

describe('ref-semantic.formatSemanticRelocateFailure', () => {
  it('包含 ref 与语义三元组', () => {
    const msg = formatSemanticRelocateFailure('e2', { role: 'link', name: 'Home', nth: 0 });
    expect(msg).toContain('ref e2');
    expect(msg).toContain('role=link');
    expect(msg).toContain('name="Home"');
    expect(msg).toContain('nth=0');
  });
});
