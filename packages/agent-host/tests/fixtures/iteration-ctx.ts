/**
 * 宿主 hook 单测的最小 IterationHookContext 构造器（ Phase 1）。
 *
 * 原来住在 agent-runtime 的 `capability/__tests__/fixtures/fake-capabilities.ts`；
 * 6 段上下文贡献迁到 agent-host/hooks 后，配套单测也迁来，这里给一份极简版本，
 * 只覆盖被迁移测试用到的字段。
 */

import type { EngineState, IterationHookContext } from '@tabtin/agent-runtime/engine'

/** beforeIteration / afterIteration 用的最小 IterationHookContext。 */
export function makeIterationCtx(state: EngineState, iteration = 0): IterationHookContext {
  return {
    state,
    iteration,
    emitEvent: () => {},
    emitNotice: () => {},
  } as unknown as IterationHookContext
}
