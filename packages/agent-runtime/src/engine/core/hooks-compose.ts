/**
 * `composeHooks` —— 把多个 EngineHooks 合并成一个。
 *
 * **历史背景（W2.2.3）**：本函数最初定义在 `middleware/index.ts`，与 7 个
 * middleware 工厂耦合在同一个 barrel 里。W2.2.3 把它从 middleware 解耦——
 * `composeHooks` 不是 middleware 特有逻辑，是 `EngineHooks` 的通用合并工具，
 * Capability 系统也需要它（`capability/prepare.ts::composeCapabilityHooks`
 * 直接调用本函数实现 hook 的合并）。
 *
 * **职责边界**：
 *   - 做：把 N 个 EngineHooks 合并成 1 个；默认按注册顺序串行执行同名钩子；
 *     `beforeRun` 额外支持并行组（见下）
 *   - 不做：错误隔离 / hook 的语义解释（这些属于具体 hook 的实装关注点）
 *
 * **错误传播（串行钩子）**：通常任一 hook 抛错会中止剩余调用；`afterRun`
 * 是生命周期清理边界，会执行全部清理后再向上传播单个错误或 AggregateError。
 *
 * **beforeRun 并行组（，承接 ）**：hooks 对象可声明
 * `beforeRunParallel: true`，表示其 `beforeRun` 与其他同样声明的 hooks
 * 互不依赖（只写自有 state 字段、对 `state.messages` 只读）。compose 时
 * **相邻**的声明 hooks 并发执行；未声明的 hooks 是屏障——执行前先等其之前
 * 的并行组全部 settle。没有 `beforeRun` 的 hooks 不参与也不隔断相邻性。
 *
 * **嵌套 compose 扁平化**：宿主装配是两层 compose——
 * `composeHooks(composeCapabilityHooks(caps), ...hostHooks)`。若不拆开，
 * 内层合并结果对外层是一个不带并行声明的普通 hook（= 屏障）。所以
 * composeHooks 对"自己产出的合并对象"做扁平化（内部 Symbol 标记）。
 *
 * 并行组错误语义：
 *   - 组内单个 hook reject **不打断**其余组员（Promise.allSettled）；
 *   - 组 settle 后若有 rejection 仍向上传播——单个错误原样 rethrow，
 *     多个错误聚合成 AggregateError。
 *
 * 其余钩子（beforeIteration / beforeModel 等）**保持严格串行**——它们存在
 * messages 写入顺序依赖。
 */

import type {
  EngineHooks,
  RunHookContext,
} from '../contracts/kernel.js';

/**
 * composeHooks 产出对象上挂原始 hooks 列表的内部标记——供外层 compose
 * 扁平化。Symbol 不导出：扁平化是 composeHooks 自己的实现细节。
 */
const COMPOSED_HOOKS_LIST = Symbol('composedHooksList');

type ComposedEngineHooks = EngineHooks & {
  [COMPOSED_HOOKS_LIST]?: readonly EngineHooks[];
};

/** 把嵌套的 composeHooks 产物展开成原始 hooks 平铺列表（保序）。 */
function flattenHooksList(hooksList: EngineHooks[]): EngineHooks[] {
  return hooksList.flatMap((h) => {
    const nested = (h as ComposedEngineHooks)[COMPOSED_HOOKS_LIST];
    return nested ? [...nested] : [h];
  });
}

/** hook 声明了并行标志且真的有 beforeRun 实体，才算并行组成员。 */
function isParallelBeforeRun(h: EngineHooks): boolean {
  return h.beforeRunParallel === true && typeof h.beforeRun === 'function';
}

/**
 * 执行一个 beforeRun 并行组：组内并发、互不打断（allSettled），
 * settle 后把 rejection 向上传播。
 */
async function runParallelBeforeRunGroup(
  group: EngineHooks[],
  ctx: RunHookContext,
): Promise<void> {
  if (group.length === 1) {
    await group[0]!.beforeRun?.(ctx);
    return;
  }
  const settled = await Promise.allSettled(group.map((h) => h.beforeRun?.(ctx)));
  const errors = settled
    .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
    .map((s) => s.reason as unknown);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'beforeRun parallel group: multiple hooks failed');
  }
}

export function composeHooks(...hooksList: EngineHooks[]): EngineHooks {
  const flat = flattenHooksList(hooksList);
  const composed: ComposedEngineHooks = {
    async beforeRun(ctx) {
      let pendingGroup: EngineHooks[] = [];
      for (const h of flat) {
        if (!h.beforeRun) continue;
        if (isParallelBeforeRun(h)) {
          pendingGroup.push(h);
          continue;
        }
        if (pendingGroup.length > 0) {
          await runParallelBeforeRunGroup(pendingGroup, ctx);
          pendingGroup = [];
        }
        await h.beforeRun(ctx);
      }
      if (pendingGroup.length > 0) {
        await runParallelBeforeRunGroup(pendingGroup, ctx);
      }
    },
    async afterRun(ctx) {
      const errors: unknown[] = [];
      for (const h of flat) {
        try {
          await h.afterRun?.(ctx);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, 'afterRun: multiple hooks failed');
      }
    },
    async beforeIteration(ctx) {
      for (const h of flat) await h.beforeIteration?.(ctx);
    },
    async afterIteration(ctx) {
      for (const h of flat) await h.afterIteration?.(ctx);
    },
    async beforeTool(ctx) {
      for (const h of flat) await h.beforeTool?.(ctx);
    },
    async afterTool(ctx) {
      for (const h of flat) await h.afterTool?.(ctx);
    },
    async beforeModel(ctx) {
      for (const h of flat) await h.beforeModel?.(ctx);
    },
    async afterModel(ctx) {
      for (const h of flat) await h.afterModel?.(ctx);
    },
    async afterToolResult(ctx) {
      for (const h of flat) await h.afterToolResult?.(ctx);
    },
    // onModelError 特殊合并：首个返回非 undefined 指令的 hook 生效（短路），
    // 后续 hook 不再调用 —— 已被处理的错误不该再被二次恢复。
    async onModelError(ctx) {
      for (const h of flat) {
        const directive = await h.onModelError?.(ctx);
        if (directive !== undefined) return directive;
      }
      return undefined;
    },
    async beforeCompact(ctx) {
      for (const h of flat) await h.beforeCompact?.(ctx);
    },
    async afterCompact(ctx) {
      for (const h of flat) await h.afterCompact?.(ctx);
    },
  };
  composed[COMPOSED_HOOKS_LIST] = flat;
  return composed;
}
