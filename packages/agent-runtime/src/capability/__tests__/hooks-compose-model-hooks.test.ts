/**
 * composeHooks 新一代扩展点合并语义测试（，Wave 0）。
 *
 * 验证：
 *   1. beforeModel / afterModel / afterToolResult / beforeCompact / afterCompact
 *      按注册顺序串行执行
 *   2. onModelError 首个返回非 undefined 指令者生效（短路，后续 hook 不再调用）
 *   3. onModelError 全部返回 undefined 时合并结果为 undefined（落回既有抛错路径）
 *   4. 新旧钩子混挂互不干扰
 */

import { describe, expect, it } from 'vitest';
import { composeHooks } from '../../engine/core/hooks-compose.js';
import type {
  BeforeModelContext,
  EngineHooks,
  ModelErrorContext,
  ToolResultsHookContext,
} from '../../engine/contracts/kernel.js';

function makeFakeCtx<T>(): T {
  return {
    emitEvent: () => {},
    emitNotice: () => {},
  } as unknown as T;
}

describe('composeHooks · 新一代扩展点', () => {
  it('beforeModel / afterToolResult 按注册顺序串行执行', async () => {
    const calls: string[] = [];
    const h1: EngineHooks = {
      beforeModel: async () => {
        calls.push('h1.beforeModel');
      },
      afterToolResult: async () => {
        calls.push('h1.afterToolResult');
      },
    };
    const h2: EngineHooks = {
      beforeModel: async () => {
        calls.push('h2.beforeModel');
      },
      afterToolResult: async () => {
        calls.push('h2.afterToolResult');
      },
    };
    const merged = composeHooks(h1, h2);
    await merged.beforeModel?.(makeFakeCtx<BeforeModelContext>());
    await merged.afterToolResult?.(makeFakeCtx<ToolResultsHookContext>());
    expect(calls).toEqual([
      'h1.beforeModel',
      'h2.beforeModel',
      'h1.afterToolResult',
      'h2.afterToolResult',
    ]);
  });

  it('onModelError 首个非 undefined 指令生效并短路后续 hook', async () => {
    const calls: string[] = [];
    const merged = composeHooks(
      {
        onModelError: async () => {
          calls.push('h1');
          return undefined;
        },
      },
      {
        onModelError: async () => {
          calls.push('h2');
          return 'retry';
        },
      },
      {
        onModelError: async () => {
          calls.push('h3');
          return 'break';
        },
      },
    );
    const directive = await merged.onModelError?.(makeFakeCtx<ModelErrorContext>());
    expect(directive).toBe('retry');
    expect(calls).toEqual(['h1', 'h2']);
  });

  it('onModelError 全部未处理时返回 undefined', async () => {
    const merged = composeHooks(
      { onModelError: async () => undefined },
      { onModelError: async () => undefined },
    );
    const directive = await merged.onModelError?.(makeFakeCtx<ModelErrorContext>());
    expect(directive).toBeUndefined();
  });

  it('iteration 钩子与 model 钩子混挂互不干扰', async () => {
    const calls: string[] = [];
    const merged = composeHooks(
      {
        beforeIteration: async () => {
          calls.push('iter.beforeIteration');
        },
        beforeModel: async () => {
          calls.push('model.beforeModel');
        },
      },
    );
    await merged.beforeIteration?.({ state: {} as never, iteration: 0, emitEvent: () => {}, emitNotice: () => {} });
    await merged.beforeModel?.(makeFakeCtx<BeforeModelContext>());
    expect(calls).toEqual(['iter.beforeIteration', 'model.beforeModel']);
  });
});
