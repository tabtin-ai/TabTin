/**
 * ：observe/SoM 采集脚本的 selector 生成——快捷属性 selector 必须验
 * document 级唯一性，兜底从「父标签 > 子标签」弱路径改为绝对 xpath。
 * 脚本在页面内执行，这里通过捕获注入脚本 + jsdom 求值验证生成逻辑。
 */
// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SoMService, SOM_EMPTY_COLLECT_RETRY_DELAYS_MS } from '../SoMService';

// jsdom 未实现 CSS.escape——采集脚本用它转义 #id，测试环境里补最小 polyfill。
if (typeof (globalThis as any).CSS === 'undefined' || typeof (globalThis as any).CSS.escape !== 'function') {
  (globalThis as any).CSS = {
    ...(globalThis as any).CSS,
    escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, '\\$1'),
  };
}

/** 捕获注入脚本并在 jsdom 里真实求值。 */
function makeCtx() {
  return {
    isAlive: () => true,
    executeScript: vi.fn(async (script: string) => {
      // eslint-disable-next-line no-eval
      return eval(script);
    }),
  } as any;
}

describe('SoM selector 生成', () => {
  it('原生表单采集可判读语义，且不暴露普通文本框的实际值', async () => {
    document.body.innerHTML = `
      <form>
        <label>Customer name: <input name="custname" value="secret-name"></label>
        <fieldset><legend>Pizza Size</legend>
          <label>Small <input type="radio" name="size" value="small" checked></label>
          <label>Large <input type="radio" name="size" value="large"></label>
        </fieldset>
        <label>Bacon <input type="checkbox" name="topping" value="bacon" checked></label>
      </form>
    `;
    for (const el of Array.from(document.querySelectorAll('input'))) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const { elements } = await new SoMService().collectInteractiveElements(makeCtx());
    const large = elements.find((el) => el.name === 'Large');
    const bacon = elements.find((el) => el.name === 'Bacon');
    const customerName = elements.find((el) => el.name === 'Customer name:');

    expect(large).toMatchObject({
      role: 'radio', name: 'Large', optionValue: 'large', checked: false,
    });
    expect(bacon).toMatchObject({
      role: 'checkbox', name: 'Bacon', optionValue: 'bacon', checked: true,
    });
    expect(customerName).toBeDefined();
    expect(JSON.stringify(customerName!.attributes)).not.toContain('secret-name');
    expect(JSON.stringify(customerName)).not.toContain('secret-name');
  });

  it('textarea 的关联名称排除控件子树，且独立 textarea 不回显初始内容', async () => {
    document.body.innerHTML = `
      <label>留言内容 <textarea id="nested-note">nested-secret</textarea></label>
      <span id="aria-note">保密说明 <textarea>aria-secret</textarea></span>
      <textarea id="aria-target" aria-labelledby="aria-note"></textarea>
      <textarea id="standalone-note">standalone-secret</textarea>
    `;
    for (const el of Array.from(document.querySelectorAll('textarea'))) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const { elements } = await new SoMService().collectInteractiveElements(makeCtx());
    const nested = elements.find((el) => el.selector === '#nested-note');
    const ariaTarget = elements.find((el) => el.selector === '#aria-target');
    const standalone = elements.find((el) => el.selector === '#standalone-note');

    expect(nested?.name).toBe('留言内容');
    expect(ariaTarget?.name).toBe('保密说明');
    expect(standalone?.name).toBe('');
    expect(JSON.stringify(elements)).not.toContain('nested-secret');
    expect(JSON.stringify(elements)).not.toContain('aria-secret');
    expect(JSON.stringify(elements)).not.toContain('standalone-secret');
  });

  it('原生控件优先于冲突的作者 role', async () => {
    document.body.innerHTML = `
      <label>Large <input type="radio" name="size" value="large" role="button"></label>
    `;
    const radio = document.querySelector('input') as HTMLInputElement;
    (radio as any).getBoundingClientRect = () => ({
      x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
    });

    const { elements } = await new SoMService().collectInteractiveElements(makeCtx());

    expect(elements[0]).toMatchObject({
      role: 'radio', name: 'Large', optionValue: 'large', checked: false,
    });
  });

  it('无属性锚点不再生成弱 selector（div > a），落到唯一 xpath', async () => {
    document.body.innerHTML = `
      <div><a href="/x">first</a></div>
      <div><a href="/y">second</a></div>
    `;

    const service = new SoMService();
    // jsdom 无布局引擎，getBoundingClientRect 恒为 0——打桩出非零尺寸让候选进入采集。
    for (const el of Array.from(document.querySelectorAll('a'))) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const { elements } = await service.collectInteractiveElements(makeCtx());

    expect(elements).toHaveLength(2);
    for (const el of elements) {
      expect(el.selector).toMatch(/^xpath=\//);
      // 生成的 xpath 必须能唯一回解到原元素
      const resolved = document.evaluate(
        el.selector.slice('xpath='.length),
        document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null,
      ).singleNodeValue;
      expect(resolved).not.toBeNull();
    }
    // 两个同构 <a> 的 xpath 必须不同（旧弱 selector 会同为 'div > a'）
    expect(elements[0].selector).not.toBe(elements[1].selector);
  });

  it('id 唯一时仍走 #id 快捷 selector', async () => {
    document.body.innerHTML = `<button id="submit-btn">Go</button>`;
    (document.getElementById('submit-btn') as any).getBoundingClientRect = () => ({
      x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
    });

    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements(makeCtx());

    expect(elements).toHaveLength(1);
    expect(elements[0].selector).toBe('#submit-btn');
    expect(elements[0]).toMatchObject({
      role: 'button',
      controlType: 'button',
      name: 'Go',
    });
  });

  it('#5376：无 id/name 但 tag.class 唯一时生成 class selector，并采集 attributes.class', async () => {
    document.body.innerHTML = `
      <div class="pagination-next" onclick="void 0"></div>
      <a href="/home" class="nav-link">首页</a>
    `;
    for (const el of Array.from(document.querySelectorAll('.pagination-next, a'))) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements(makeCtx());

    const next = elements.find((e) => e.attributes?.class === 'pagination-next');
    expect(next).toBeDefined();
    // 无文本图标控件：class 成为唯一语义线索 + 定位依据
    expect(next!.name).toBe('');
    expect(next!.selector).toBe('div.pagination-next');
    // 链接元素同时保留 href 与 class
    const link = elements.find((e) => e.tag === 'a');
    expect(link!.attributes?.class).toBe('nav-link');
    expect(link!.attributes?.href).toContain('/home');
  });

  it('#5376：hash 化 / 过长的 class 被过滤，tag.class 不唯一时落 xpath 但仍带 attributes.class', async () => {
    document.body.innerHTML = `
      <button class="btn css-a1b2c3d4e5f6">one</button>
      <button class="btn">two</button>
    `;
    for (const el of Array.from(document.querySelectorAll('button'))) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements(makeCtx());

    expect(elements).toHaveLength(2);
    // hash 化 token（css-a1b2c3d4e5f6 含 8+ 位十六进制段）被过滤，只留可读 class
    expect(elements[0].attributes?.class).toBe('btn');
    // button.btn 命中两个元素 → 不唯一 → 落绝对 xpath（ 口径）
    for (const el of elements) {
      expect(el.selector).toMatch(/^xpath=\//);
      expect(el.attributes?.class).toBe('btn');
    }
  });

  it('JS 挂载 onclick property（无 [onclick] attribute）的元素进候选——hover 顶导场景', async () => {
    // 36kr 首页「创投平台」形态：div.nav-label 无 href/role/tabindex/onclick attr，
    // 点击行为由框架以 el.onclick = fn 挂载，[onclick] 属性选择器抓不到。
    document.body.innerHTML = `
      <li class="nav-wrapper"><div class="nav-label"><span>创投平台</span></div></li>
      <a href="/home" class="nav-link">首页</a>
    `;
    const navLabel = document.querySelector('.nav-label') as HTMLElement;
    navLabel.onclick = () => {};
    // 已在候选集里的 <a> 同时挂 onclick property，验证去重不重复采集
    const link = document.querySelector('a') as HTMLElement;
    link.onclick = () => {};
    for (const el of [navLabel, link]) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements(makeCtx());

    expect(elements).toHaveLength(2);
    const label = elements.find((e) => e.tag === 'div');
    expect(label).toBeDefined();
    // name 走既有 textContent 链，无需任何兜底
    expect(label!.name).toBe('创投平台');
    expect(label!.selector).toBe('div.nav-label');
    // property 候选追加在选择器候选之后，<a> 序号在前且只出现一次
    expect(elements.filter((e) => e.tag === 'a')).toHaveLength(1);
    expect(elements[0].tag).toBe('a');
  });

  it('id 重复（非法但真实存在）时放弃 #id，落到 xpath', async () => {
    document.body.innerHTML = `
      <a id="dup" href="/a">one</a>
      <a id="dup" href="/b">two</a>
    `;
    for (const el of Array.from(document.querySelectorAll('a'))) {
      (el as any).getBoundingClientRect = () => ({
        x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
      });
    }

    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements(makeCtx());

    expect(elements).toHaveLength(2);
    for (const el of elements) {
      expect(el.selector).toMatch(/^xpath=\//);
    }
  });
});

describe('SoM selector 生成（ shadow）', () => {
  it('shadow 内按钮生成深选择器且可 DeepQuery 回解，不落 light xpath', async () => {
    document.body.innerHTML = '';
    const host = document.createElement('bili-comments');
    host.id = 'c-host';
    const s1 = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.setAttribute('aria-label', '回复');
    btn.textContent = '回复';
    s1.appendChild(btn);
    document.body.appendChild(host);
    (btn as any).getBoundingClientRect = () => ({
      x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
    });

    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements(makeCtx());
    const hit = elements.find((e) => e.name.includes('回复') || e.tag === 'button');
    expect(hit).toBeTruthy();
    expect(hit!.selector).toContain(' >>> ');
    expect(hit!.selector.startsWith('xpath=')).toBe(false);

    // 回解：复用页面 helpers（与 SoM 注入同源）
    const { SHADOW_DOM_HELPERS_SNIPPET } = await import('../../page-scripts/shadow-dom');
    const deepQuery = new Function(
      `${SHADOW_DOM_HELPERS_SNIPPET}; return __tabtinDeepQuery;`,
    )() as (sel: string) => Element | null;
    expect(deepQuery(hit!.selector)).toBe(btn);
  });

  it('无 shadow 时仍可走 #id / xpath，且不强制 >>>', async () => {
    document.body.innerHTML = `<button id="only">Go</button>`;
    (document.getElementById('only') as any).getBoundingClientRect = () => ({
      x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
    });
    const { elements } = await new SoMService().collectInteractiveElements(makeCtx());
    expect(elements).toHaveLength(1);
    expect(elements[0].selector).toBe('#only');
  });
});

describe('SoM 空结果重采（SPA 渲染空窗）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const nonEmptyRaw = {
    elements: [{
      id: 1, tag: 'a', role: '', name: '首页', selector: 'a.nav-link',
      bbox: { x: 0, y: 0, width: 10, height: 10 }, visible: true, interactive: true,
    }],
    totalCandidates: 1,
  };

  it('首采即有元素时不重试、无额外延迟', async () => {
    const executeScript = vi.fn(async () => nonEmptyRaw);
    const service = new SoMService();
    const { elements } = await service.collectInteractiveElements({ isAlive: () => true, executeScript } as any);
    expect(elements).toHaveLength(1);
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('首采为空（SPA 未渲染完）时按退避重采，采到即返回', async () => {
    vi.useFakeTimers();
    const executeScript = vi.fn()
      .mockResolvedValueOnce({ elements: [], totalCandidates: 0 })
      .mockResolvedValue(nonEmptyRaw);
    const service = new SoMService();

    const pending = service.collectInteractiveElements({ isAlive: () => true, executeScript } as any);
    await vi.advanceTimersByTimeAsync(SOM_EMPTY_COLLECT_RETRY_DELAYS_MS[0]);
    const { elements } = await pending;

    expect(elements).toHaveLength(1);
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('持续为空（真实空白页）时按上限重采后如实返回空', async () => {
    vi.useFakeTimers();
    const executeScript = vi.fn(async () => ({ elements: [], totalCandidates: 0 }));
    const service = new SoMService();

    const pending = service.collectInteractiveElements({ isAlive: () => true, executeScript } as any);
    const totalMs = SOM_EMPTY_COLLECT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    await vi.advanceTimersByTimeAsync(totalMs);
    const { elements } = await pending;

    expect(elements).toHaveLength(0);
    expect(executeScript).toHaveBeenCalledTimes(1 + SOM_EMPTY_COLLECT_RETRY_DELAYS_MS.length);
  });
});
