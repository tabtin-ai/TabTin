/**
 * ：resolveElementCenter 不再死磕 querySelector 首个匹配——
 * 扫描全部匹配取第一个可见者；全不可见时报带匹配数的可诊断错误。
 */
import { describe, it, expect, vi } from 'vitest';
import { CDPOperationHelper } from '../CDPOperationHelper';

type CDPHandler = (params: any) => any;

function makeCtx(handlers: Record<string, CDPHandler> & { executeScript?: (code: string) => any }) {
  return {
    isAlive: () => true,
    sendCDP: vi.fn(async (method: string, params: any) => {
      const handler = handlers[method];
      if (!handler && method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (!handler) throw new Error(`unexpected CDP method: ${method}`);
      return handler(params);
    }),
    executeScript: vi.fn(async (code: string) => {
      if (handlers.executeScript) return handlers.executeScript(code);
      return { ok: false, cx: 0, cy: 0, w: 0, h: 0 };
    }),
  } as any;
}

const BOX = { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };

describe('resolveElementCenter 可见匹配扫描', () => {
  it('XPath 搜索前先获取 DOM 文档，使 getSearchResults 的 nodeId 可用于后续 CDP 操作', async () => {
    let documentRequested = false;
    const ctx = makeCtx({
      'DOM.getDocument': () => {
        documentRequested = true;
        return { root: { nodeId: 1 } };
      },
      'DOM.performSearch': () => {
        if (!documentRequested) throw new Error('DOM document was not requested');
        return { searchId: 's-native', resultCount: 1 };
      },
      'DOM.getSearchResults': () => ({ nodeIds: [23] }),
      'DOM.discardSearchResults': () => ({}),
    });

    const helper = new CDPOperationHelper();
    const nodeIds = await (helper as any).queryMatchingNodeIds(
      ctx,
      'xpath=/html[1]/body[1]/form[1]/input[1]',
    );

    expect(nodeIds).toEqual([23]);
    expect(documentRequested).toBe(true);
  });

  it('原生控件优先使用 border quad 中心，避免空 content box 落到控件外', async () => {
    const ctx = makeCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelectorAll': () => ({ nodeIds: [7] }),
      'DOM.getBoxModel': () => ({
        model: {
          content: [0, 0, 0, 0, 0, 0, 0, 0],
          border: [10, 20, 30, 20, 30, 40, 10, 40],
        },
      }),
      'DOM.scrollIntoViewIfNeeded': () => ({}),
      'DOM.describeNode': () => ({ node: { backendNodeId: 70 } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj7' } }),
    });

    const helper = new CDPOperationHelper();
    const result = await (helper as any).resolveElementCenter(ctx, '#native-control', 500);

    expect(result.cx).toBe(20);
    expect(result.cy).toBe(30);
  });

  it('CSS 多匹配：首个不可见时命中第二个可见元素', async () => {
    const ctx = makeCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelectorAll': () => ({ nodeIds: [11, 22] }),
      'DOM.getBoxModel': ({ nodeId }: any) => {
        if (nodeId === 11) throw new Error('Could not compute box model');
        return BOX;
      },
      'DOM.scrollIntoViewIfNeeded': () => ({}),
      'DOM.describeNode': () => ({ node: { backendNodeId: 220 } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj22' } }),
    });

    const helper = new CDPOperationHelper();
    const result = await (helper as any).resolveElementCenter(ctx, 'div > a', 500);

    expect(result.nodeId).toBe(22);
    expect(result.cx).toBe(5);
    expect(result.cy).toBe(5);
    expect(result.objectId).toBe('obj22');
  });

  it('全部匹配不可报错带匹配数且消息可触发语义重定位', async () => {
    const ctx = makeCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelectorAll': () => ({ nodeIds: [11, 22] }),
      'DOM.getBoxModel': () => {
        throw new Error('Could not compute box model');
      },
      'DOM.scrollIntoViewIfNeeded': () => ({}),
      executeScript: () => ({ ok: false, cx: 0, cy: 0, w: 0, h: 0 }),
    });

    const helper = new CDPOperationHelper();
    await expect(
      (helper as any).resolveElementCenter(ctx, 'div > a', 300),
    ).rejects.toThrow(/not found or not visible.*2 matches, none visible/);
  });

  it('唯一匹配在视口外：probe 无盒子时 scroll 后重试可点', async () => {
    let scrolled = false;
    const scroll = vi.fn(() => {
      scrolled = true;
      return {};
    });
    const ctx = makeCtx({
      'DOM.performSearch': () => ({ searchId: 's-page', resultCount: 1 }),
      'DOM.getSearchResults': () => ({ nodeIds: [73] }),
      'DOM.discardSearchResults': () => ({}),
      'DOM.getBoxModel': () => {
        if (!scrolled) throw new Error('Could not compute box model');
        return BOX;
      },
      'DOM.scrollIntoViewIfNeeded': scroll,
      'DOM.describeNode': () => ({ node: { backendNodeId: 730 } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj73' } }),
    });

    const helper = new CDPOperationHelper();
    const result = await (helper as any).resolveElementCenter(
      ctx,
      'xpath=/html[1]/body[1]/ul[1]/li[2]/button[1]',
      500,
    );

    expect(result.nodeId).toBe(73);
    expect(result.cx).toBe(5);
    expect(result.cy).toBe(5);
    expect(scroll).toHaveBeenCalled();
  });

  it('无任何匹配：报 not found（无匹配数后缀）', async () => {
    const ctx = makeCtx({
      'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
      'DOM.querySelectorAll': () => ({ nodeIds: [] }),
      executeScript: () => ({ ok: false, cx: 0, cy: 0, w: 0, h: 0 }),
    });

    const helper = new CDPOperationHelper();
    await expect(
      (helper as any).resolveElementCenter(ctx, '#missing', 300),
    ).rejects.toThrow(/Element not found or not visible: #missing$/);
  });

  it('CDP scroll 后仍无 box：executeScript scrollIntoView + getBoundingClientRect 兜底可点', async () => {
    const executeScript = vi.fn(() => ({
      ok: true,
      cx: 120,
      cy: 640,
      w: 30,
      h: 24,
    }));
    const ctx = makeCtx({
      'DOM.performSearch': () => ({ searchId: 's-js', resultCount: 1 }),
      'DOM.getSearchResults': () => ({ nodeIds: [215] }),
      'DOM.discardSearchResults': () => ({}),
      'DOM.getBoxModel': () => {
        throw new Error('Could not compute box model');
      },
      'DOM.scrollIntoViewIfNeeded': () => ({}),
      executeScript,
    });

    const helper = new CDPOperationHelper();
    const result = await (helper as any).resolveElementCenter(
      ctx,
      'xpath=/html[1]/body[1]/ul[1]/li[2]/button[1]',
      500,
    );

    expect(executeScript).toHaveBeenCalled();
    expect(result).toMatchObject({
      cx: 120,
      cy: 640,
      nodeId: -1,
      backendNodeId: -1,
    });
  });

  it('xpath 多匹配：performSearch 结果同样扫描可见者并清理 searchId', async () => {
    const discard = vi.fn(() => ({}));
    const ctx = makeCtx({
      'DOM.performSearch': () => ({ searchId: 's1', resultCount: 2 }),
      'DOM.getSearchResults': () => ({ nodeIds: [31, 32] }),
      'DOM.discardSearchResults': discard,
      'DOM.getBoxModel': ({ nodeId }: any) => {
        if (nodeId === 31) throw new Error('Could not compute box model');
        return BOX;
      },
      'DOM.scrollIntoViewIfNeeded': () => ({}),
      'DOM.describeNode': () => ({ node: { backendNodeId: 320 } }),
      'DOM.resolveNode': () => ({ object: { objectId: 'obj32' } }),
    });

    const helper = new CDPOperationHelper();
    const result = await (helper as any).resolveElementCenter(ctx, 'xpath=/html/body//a', 500);

    expect(result.nodeId).toBe(32);
    expect(discard).toHaveBeenCalledWith({ searchId: 's1' });
  });
});
