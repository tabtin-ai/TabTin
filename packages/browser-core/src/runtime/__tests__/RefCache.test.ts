import { describe, it, expect } from 'vitest';
import { RefCache, getSharedRefCache, resetSharedRefCache } from '../RefCache';
import type { RefEntry } from '../RefCache';

/**
 * BR-8 WS-B / P3a：RefCache 单测。
 * 钉住「snapshot 填充 eN→selector → act 回解 ref/toRef」的核心行为：
 * replace 整表语义、回解只补缺、显式 selector 优先、多 tab 隔离、空 tabId 兜底键、
 * clear 生命周期、共享单例。
 */

function entry(selector: string): RefEntry {
  return { selector, timestamp: Date.now() };
}

describe('RefCache —— 填充与回解', () => {
  it('replace 后 act 的 ref 回解成 selector', () => {
    const cache = new RefCache();
    cache.replace('t1', [
      ['e1', entry('#login')],
      ['e2', entry('button.submit')],
    ]);

    const resolved = cache.resolveRefsInActions(
      [{ type: 'click', ref: 'e1' }, { type: 'click', ref: 'e2' }],
      't1',
    );
    expect(resolved[0].selector).toBe('#login');
    expect(resolved[1].selector).toBe('button.submit');
  });

  it('BW-1：回解 ref 时附带 refSemantic 供 act 失效重定位', () => {
    const cache = new RefCache();
    cache.replace('t1', [
      [
        'e1',
        {
          selector: 'xpath=/html/body/a[1]',
          semantic: { role: 'link', name: 'Home', nth: 0 },
          timestamp: Date.now(),
        },
      ],
    ]);

    const resolved = cache.resolveRefsInActions([{ type: 'click', ref: 'e1' }], 't1');
    expect(resolved[0].selector).toBe('xpath=/html/body/a[1]');
    expect(resolved[0].refSemantic).toEqual({ role: 'link', name: 'Home', nth: 0 });
  });

  it('回解 iframe ref 时同时附带所属 frameId', () => {
    const cache = new RefCache();
    cache.replace('t1', [[
      'e1',
      { selector: '#mobile', frameId: 'frame-20', timestamp: Date.now() },
    ]]);

    const resolved = cache.resolveRefsInActions([{ type: 'click', ref: 'e1' }], 't1');

    expect(resolved[0]).toMatchObject({
      selector: '#mobile',
      frameId: 'frame-20',
    });
  });

  it('toRef 回解成 toSelector（drag 等双目标 action）', () => {
    const cache = new RefCache();
    cache.replace('t1', [
      ['e1', entry('#src')],
      ['e2', entry('#dst')],
    ]);
    const resolved = cache.resolveRefsInActions(
      [{ type: 'drag', ref: 'e1', toRef: 'e2' }],
      't1',
    );
    expect(resolved[0].selector).toBe('#src');
    expect(resolved[0].toSelector).toBe('#dst');
  });

  it('显式 selector / toSelector 优先，不被 ref 覆盖', () => {
    const cache = new RefCache();
    cache.replace('t1', [[
      'e1',
      { selector: '#from-ref', frameId: 'frame-20', timestamp: Date.now() },
    ]]);
    const resolved = cache.resolveRefsInActions(
      [{ type: 'click', ref: 'e1', selector: '#explicit' }],
      't1',
    );
    expect(resolved[0].selector).toBe('#explicit');
    expect(resolved[0].frameId).toBeUndefined();
  });

  it('查不到的 ref 原样透传，不报错', () => {
    const cache = new RefCache();
    cache.replace('t1', [['e1', entry('#a')]]);
    const resolved = cache.resolveRefsInActions(
      [{ type: 'click', ref: 'e99' }],
      't1',
    );
    expect(resolved[0].selector).toBeUndefined();
    expect(resolved[0].ref).toBe('e99');
  });

  it('该 tab 从未 snapshot（无缓存）→ actions 原样返回', () => {
    const cache = new RefCache();
    const actions = [{ type: 'click', ref: 'e1' }];
    expect(cache.resolveRefsInActions(actions, 'never')).toBe(actions);
  });

  it('回解不就地改入参（浅拷贝）', () => {
    const cache = new RefCache();
    cache.replace('t1', [['e1', entry('#a')]]);
    const input = [{ type: 'click', ref: 'e1' }];
    const resolved = cache.resolveRefsInActions(input, 't1');
    expect((input[0] as any).selector).toBeUndefined();
    expect(resolved[0].selector).toBe('#a');
  });
});

describe('RefCache —— replace 整表语义', () => {
  it('replace 先清后填：上一页的 eN 不残留', () => {
    const cache = new RefCache();
    cache.replace('t1', [['e1', entry('#old1')], ['e2', entry('#old2')]]);
    expect(cache.size('t1')).toBe(2);

    // 新一页只剩一个元素
    cache.replace('t1', [['e1', entry('#new1')]]);
    expect(cache.size('t1')).toBe(1);

    const resolved = cache.resolveRefsInActions(
      [{ type: 'click', ref: 'e1' }, { type: 'click', ref: 'e2' }],
      't1',
    );
    expect(resolved[0].selector).toBe('#new1');
    expect(resolved[1].selector).toBeUndefined(); // 旧 e2 已被清掉
  });
});

describe('RefCache —— 多 tab 隔离与 clear', () => {
  it('不同 tab 的引用互相隔离', () => {
    const cache = new RefCache();
    cache.replace('t1', [['e1', entry('#a')]]);
    cache.replace('t2', [['e1', entry('#b')]]);
    expect(cache.resolveRefsInActions([{ ref: 'e1' }], 't1')[0].selector).toBe('#a');
    expect(cache.resolveRefsInActions([{ ref: 'e1' }], 't2')[0].selector).toBe('#b');
  });

  it('clear 只清指定 tab', () => {
    const cache = new RefCache();
    cache.replace('t1', [['e1', entry('#a')]]);
    cache.replace('t2', [['e1', entry('#b')]]);
    cache.clear('t1');
    expect(cache.has('t1')).toBe(false);
    expect(cache.size('t1')).toBe(0);
    expect(cache.size('t2')).toBe(1);
  });

  it('clearAll 清空所有 tab', () => {
    const cache = new RefCache();
    cache.replace('t1', [['e1', entry('#a')]]);
    cache.replace('t2', [['e1', entry('#b')]]);
    cache.clearAll();
    expect(cache.size('t1')).toBe(0);
    expect(cache.size('t2')).toBe(0);
  });
});

describe('RefCache —— 空 tabId 兜底键', () => {
  it('空/undefined tabId 都归一到同一兜底键（与 route 的 __default 口径一致）', () => {
    const cache = new RefCache();
    cache.replace('', [['e1', entry('#a')]]);
    // 用 undefined 查应命中同一桶
    expect(cache.resolveRefsInActions([{ ref: 'e1' }], undefined)[0].selector).toBe('#a');
    expect(cache.resolveRefsInActions([{ ref: 'e1' }], '')[0].selector).toBe('#a');
  });
});

describe('RefCache —— set 单条写入', () => {
  it('set 增量写入、不清表', () => {
    const cache = new RefCache();
    cache.set('t1', 'e1', entry('#a'));
    cache.set('t1', 'e2', entry('#b'));
    expect(cache.size('t1')).toBe(2);
    expect(cache.get('t1').get('e2')?.selector).toBe('#b');
  });
});

describe('RefCache —— 共享单例', () => {
  it('getSharedRefCache 返回同一实例；reset 后换新实例', () => {
    resetSharedRefCache();
    const a = getSharedRefCache();
    a.replace('t1', [['e1', entry('#a')]]);
    expect(getSharedRefCache()).toBe(a);
    expect(getSharedRefCache().size('t1')).toBe(1);

    resetSharedRefCache();
    const b = getSharedRefCache();
    expect(b).not.toBe(a);
    expect(b.size('t1')).toBe(0);
  });
});
