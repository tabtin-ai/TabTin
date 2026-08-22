// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DOMOperationHelper } from '../DOMOperationHelper';

if (typeof (globalThis as any).CSS === 'undefined' || typeof (globalThis as any).CSS.escape !== 'function') {
  (globalThis as any).CSS = {
    ...(globalThis as any).CSS,
    escape: (s: string) => s.replace(/([^a-zA-Z0-9_-])/g, '\\$1'),
  };
}

function makeCtx() {
  return {
    executeScript: vi.fn(async (script: string) => {
      // eslint-disable-next-line no-eval
      return eval(script);
    }),
  } as any;
}

/**
 * 模拟 React 挂在元素实例上的 value tracker：直接写 element.value 会先更新
 * tracker，后续 input 事件会被视作“没有变化”；绕过实例 setter 才能触发状态更新。
 */
function installReactStyleValueTracker(element: HTMLInputElement | HTMLTextAreaElement) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const nativeValue = Object.getOwnPropertyDescriptor(prototype, 'value');
  if (!nativeValue?.get || !nativeValue.set) throw new Error('missing native value descriptor');

  let trackedValue = nativeValue.get.call(element);
  let componentValue = '';

  Object.defineProperty(element, 'value', {
    configurable: true,
    get: () => nativeValue.get!.call(element),
    set: (next: string) => {
      nativeValue.set!.call(element, next);
      trackedValue = String(next);
    },
  });

  element.addEventListener('input', () => {
    const next = nativeValue.get!.call(element);
    if (next === trackedValue) return;
    trackedValue = next;
    componentValue = next;
  });

  return () => componentValue;
}

describe('DOMOperationHelper shadow', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('深选择器 click 命中 shadow 内按钮', async () => {
    const host = document.createElement('x-host');
    host.id = 'h';
    const root = host.attachShadow({ mode: 'open' });
    const btn = document.createElement('button');
    btn.id = 'inner-btn';
    let clicked = false;
    btn.addEventListener('click', () => {
      clicked = true;
    });
    root.appendChild(btn);
    document.body.appendChild(host);
    (btn as any).getBoundingClientRect = () => ({
      x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
    });
    // jsdom getComputedStyle 默认可见

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#h >>> #inner-btn',
      action: 'click',
      waitForVisible: false,
      scrollIntoView: false,
      timeout: 500,
    });
    expect(result.success).toBe(true);
    expect(clicked).toBe(true);
  });

  it('普通 #id 仍走原路径', async () => {
    document.body.innerHTML = `<button id="plain">P</button>`;
    const el = document.getElementById('plain')!;
    let clicked = false;
    el.addEventListener('click', () => {
      clicked = true;
    });
    (el as any).getBoundingClientRect = () => ({
      x: 0, y: 0, width: 10, height: 10, top: 0, bottom: 10, left: 0, right: 10,
    });
    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#plain',
      action: 'click',
      waitForVisible: false,
      scrollIntoView: false,
      timeout: 500,
    });
    expect(result.success).toBe(true);
    expect(clicked).toBe(true);
  });

  it('深选择器找不到 → element_not_found', async () => {
    document.body.innerHTML = `<div id="h"></div>`;
    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#h >>> #missing',
      action: 'click',
      waitForVisible: false,
      scrollIntoView: false,
      timeout: 200,
      retries: 0,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('element_not_found');
  });

  it('表单动作回读实际值与原生控件状态，并拒绝未生效的填写', async () => {
    document.body.innerHTML = `
      <input id="name" value="old">
      <input id="large" type="radio" name="size" value="large">
      <input id="bacon" type="checkbox" value="bacon">
    `;

    const fill = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#name', action: 'fill', value: '张三', waitForVisible: false, scrollIntoView: false,
    });
    const radio = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#large', action: 'click', waitForVisible: false, scrollIntoView: false,
    });
    const checkbox = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#bacon', action: 'click', waitForVisible: false, scrollIntoView: false,
    });

    expect(fill).toMatchObject({ success: true, actualValue: '张三' });
    expect(radio).toMatchObject({ success: true, controlValue: 'large', checked: true });
    expect(checkbox).toMatchObject({ success: true, controlValue: 'bacon', checked: true });

    const rejected = document.createElement('div') as HTMLElement & { value?: string };
    rejected.id = 'rejected';
    document.body.appendChild(rejected);
    Object.defineProperty(rejected, 'value', {
      configurable: true,
      get: () => 'old',
      set: () => undefined,
    });

    const failedFill = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#rejected', action: 'fill', value: '李四', waitForVisible: false, scrollIntoView: false,
    });

    expect(failedFill).toMatchObject({ success: false, code: 'invalid_parameter' });
  });

  it('fill 绕过 React 式 value tracker，使受控 input 收到状态更新', async () => {
    document.body.innerHTML = '<input id="link" value="">';
    const input = document.getElementById('link') as HTMLInputElement;
    const getComponentValue = installReactStyleValueTracker(input);

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#link', action: 'fill', value: 'https://v.douyin.com/example/',
      waitForVisible: false, scrollIntoView: false,
    });

    expect(result).toMatchObject({ success: true, actualValue: 'https://v.douyin.com/example/' });
    expect(getComponentValue()).toBe('https://v.douyin.com/example/');
  });

  it('fill 在页面异步回滚输入值时返回失败，而不是假成功', async () => {
    document.body.innerHTML = '<textarea id="notes"></textarea>';
    const textarea = document.getElementById('notes') as HTMLTextAreaElement;
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
    if (!nativeValue?.set) throw new Error('missing textarea value setter');
    textarea.addEventListener('input', () => {
      queueMicrotask(() => nativeValue.set!.call(textarea, ''));
    });

    const result = await DOMOperationHelper.runAction(makeCtx(), {
      selector: '#notes', action: 'fill', value: 'TabTin agent form test',
      waitForVisible: false, scrollIntoView: false,
    });

    expect(result).toMatchObject({ success: false, code: 'invalid_parameter', actualValue: '' });
  });
});
