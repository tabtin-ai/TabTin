/**
 * cost-cap-config.ts — 装配 `CostCap` 时的 `execution_limits` 归一 + 组合
 * SSoT，抽自两端 host 装配段（Electron `ElectronAgentHost.createRuntimeForSession`
 * L8448 / L9068 + Daemon `DaemonAgentHost.createRuntimeForSession` L6356）。
 *
 * 为什么下沉：
 *   - W2.3-fix（F8）：v2 `agent_config.capabilities.overrides.cost.execution_limits`
 *     的 `max_credits_per_run` 是 Django 校验后 stringify 的字符串（避免 JSON
 *     浮点精度）；CostCap 期望 `number`，两端都要走
 *     `normalizeExecutionLimitsForCostCap` 归一后再装配。
 *   - 两端 host 各自 inline `new CostCap({ config: { execution_limits: {...} } })`
 *     的形状完全一致——不下沉一个 shape helper，任何一端漏改就产生漂移。
 *
 * 参考：
 *   - `packages/app-shell/src/utils/agent-config-v2.ts:normalizeExecutionLimitsForCostCap`
 *   - `packages/agent-runtime/src/capability/governance/cost.ts:CostCapInit`
 */

/**
 * 内联 v2 execution_limits 归一——语义与 `@tabtin/app-shell/agent-config-v2` 的
 * `normalizeExecutionLimitsForCostCap` 逐字对齐（含 Django stringify credits 场景），
 * 内联是因为 app-shell 挂着 react / zustand peer deps，把它拉进
 * `@tabtin/agent-host`（纯运行时包）会污染依赖边界。任一端要改归一规则，两处
 * 都要同步（`packages/app-shell/tests/agent-config-v2.test.ts` 是权威 fixture）。
 */
interface NormalizedCostExecutionLimits {
  max_iterations_per_run?: number
  max_credits_per_run?: number
}

function normalizeExecutionLimitsForCostCap(
  raw: unknown,
): NormalizedCostExecutionLimits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const result: NormalizedCostExecutionLimits = {}

  const iter = obj.max_iterations_per_run
  if (typeof iter === 'number' && Number.isFinite(iter) && iter >= 1) {
    result.max_iterations_per_run = Math.floor(iter)
  }

  const credits = obj.max_credits_per_run
  if (typeof credits === 'number' && Number.isFinite(credits) && credits > 0) {
    result.max_credits_per_run = credits
  } else if (typeof credits === 'string' && credits.trim()) {
    const parsed = parseFloat(credits)
    if (Number.isFinite(parsed) && parsed > 0) {
      result.max_credits_per_run = parsed
    }
  }

  return Object.keys(result).length > 0 ? result : undefined
}

/**
 * `CostCap` 装配所需入参。返回对象形状与 `CostCapInit` 兼容，宿主可以直接
 * `new CostCap(buildCostCapConfig(...))`。
 *
 * `execution_limits` 与 `resolveContextWindow` 都是 CostCap 可选字段：调用方
 * 若不需要显式上限（走 DEFAULT_MAX_CREDITS_PER_RUN 兜底），依然传入本 helper
 * ——helper 会保证脏数据归一到 undefined，避免"配置字符串误把 credits 关成 0"
 * 这种坏路径。
 */
export interface BuildCostCapConfigInput {
  /**
   * 来自 v2 `agent_config.capabilities.overrides.cost.execution_limits` 的
   * 原始子树。Django 校验后 `max_credits_per_run` 可能是 string。
   */
  executionLimits?: {
    max_iterations_per_run?: number | null
    max_credits_per_run?: number | string | null
  }
  /**
   * 静态 context window fallback。CostCap 优先用 resolveContextWindow(model)
   * 结果，仅在缺 resolver 时读它。
   */
  contextWindowTokens: number
  /**
   * 动态 context window resolver——通常传两端 host 内的
   * `dynamicResolveContextWindow`。签名保持宽松（返 number）以避开 host 与
   * capability 层的循环依赖。
   */
  resolveContextWindow: (model: string) => number
}

/**
 * 与 `CostCapInit`（`packages/agent-runtime/src/capability/governance/cost.ts`）
 * 字段名保持一致。TypeScript 结构类型下可直接 `new CostCap(result)`。
 */
export interface BuildCostCapConfigResult {
  config: {
    execution_limits: {
      max_iterations_per_run?: number
      max_credits_per_run?: number
    }
  }
  contextWindowTokens: number
  resolveContextWindow: (model: string) => number
}

/**
 * 归一 + 组合。空 / 脏 `executionLimits` → 输出 execution_limits 里的两个字段
 * 均为 undefined（CostCap 走内置默认）。合法 v2 形态 → number 落位。
 */
export function buildCostCapConfig(
  input: BuildCostCapConfigInput,
): BuildCostCapConfigResult {
  const normalized = normalizeExecutionLimitsForCostCap(input.executionLimits)
  return {
    config: {
      execution_limits: {
        max_iterations_per_run: normalized?.max_iterations_per_run,
        max_credits_per_run: normalized?.max_credits_per_run,
      },
    },
    contextWindowTokens: input.contextWindowTokens,
    resolveContextWindow: input.resolveContextWindow,
  }
}
