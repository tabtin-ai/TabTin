/**
 * composeHooks beforeRun 并行组。
 */
import { describe, expect, it } from 'vitest';
import { composeHooks } from '../../engine/core/hooks-compose.js';
import type { EngineHooks, RunHookContext } from '../../engine/contracts/kernel.js';

function makeRunCtx(): RunHookContext {
  return {
    state: { messages: [] } as RunHookContext['state'],
    runId: 'test-run',
    emitEvent: () => {},
    emitNotice: () => {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('composeHooks · beforeRunParallel', () => {
  it('相邻 beforeRunParallel hooks 并发执行（耗时取 max 而非 sum）', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number): EngineHooks => ({
      beforeRunParallel: true,
      beforeRun: async () => {
        order.push(`${name}:start`);
        await sleep(ms);
        order.push(`${name}:end`);
      },
    });
    const merged = composeHooks(slow('a', 40), slow('b', 40), slow('c', 40));
    const t0 = Date.now();
    await merged.beforeRun?.(makeRunCtx());
    const elapsed = Date.now() - t0;
    expect(order.filter((x) => x.endsWith(':start')).sort()).toEqual([
      'a:start',
      'b:start',
      'c:start',
    ]);
    expect(elapsed).toBeLessThan(100);
  });

  it('未声明并行的 beforeRun 是屏障：其前并行组先 settle，其后重新聚拢', async () => {
    const order: string[] = [];
    const parallel = (name: string): EngineHooks => ({
      beforeRunParallel: true,
      beforeRun: async () => {
        order.push(name);
      },
    });
    const barrier: EngineHooks = {
      beforeRun: async () => {
        order.push('barrier');
      },
    };
    const merged = composeHooks(parallel('p1'), parallel('p2'), barrier, parallel('p3'));
    await merged.beforeRun?.(makeRunCtx());
    expect(order.indexOf('barrier')).toBeGreaterThan(order.indexOf('p1'));
    expect(order.indexOf('barrier')).toBeGreaterThan(order.indexOf('p2'));
    expect(order.indexOf('p3')).toBeGreaterThan(order.indexOf('barrier'));
  });

  it('嵌套 compose 扁平化后外层并行 hook 能与内层并行组同组并发', async () => {
    const starts: string[] = [];
    const parallel = (name: string): EngineHooks => ({
      beforeRunParallel: true,
      beforeRun: async () => {
        starts.push(name);
        await sleep(30);
      },
    });
    const inner = composeHooks(parallel('cap-a'), parallel('cap-b'));
    const merged = composeHooks(inner, parallel('host'));
    const t0 = Date.now();
    await merged.beforeRun?.(makeRunCtx());
    expect(starts.sort()).toEqual(['cap-a', 'cap-b', 'host']);
    expect(Date.now() - t0).toBeLessThan(80);
  });

  it('并行组单错原样 rethrow，多错 AggregateError', async () => {
    const ok: EngineHooks = {
      beforeRunParallel: true,
      beforeRun: async () => {},
    };
    const failA: EngineHooks = {
      beforeRunParallel: true,
      beforeRun: async () => {
        throw new Error('fail-a');
      },
    };
    const failB: EngineHooks = {
      beforeRunParallel: true,
      beforeRun: async () => {
        throw new Error('fail-b');
      },
    };
    await expect(composeHooks(ok, failA).beforeRun?.(makeRunCtx())).rejects.toThrow('fail-a');
    await expect(composeHooks(failA, failB).beforeRun?.(makeRunCtx())).rejects.toBeInstanceOf(
      AggregateError,
    );
  });

  it('beforeIteration 仍严格串行', async () => {
    const order: string[] = [];
    const h = (name: string): EngineHooks => ({
      beforeRunParallel: true,
      beforeIteration: async () => {
        order.push(`${name}:start`);
        await sleep(15);
        order.push(`${name}:end`);
      },
    });
    const merged = composeHooks(h('a'), h('b'));
    await merged.beforeIteration?.({
      ...makeRunCtx(),
      iteration: 0,
      requestForceFinal: () => {},
    });
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('afterRun 前序 hook 失败时仍执行后续清理 hook', async () => {
    const order: string[] = [];
    const merged = composeHooks(
      {
        afterRun: async () => {
          order.push('failed');
          throw new Error('cleanup failed');
        },
      },
      {
        afterRun: async () => {
          order.push('lease released');
        },
      },
    );

    await expect(merged.afterRun?.(makeRunCtx())).rejects.toThrow('cleanup failed');
    expect(order).toEqual(['failed', 'lease released']);
  });
});
