/**
 * agent_config v2 工具函数（W2.1.0 决议 §2 / D2.2）
 *
 * 与 Django 端 `apps/tabtinspace/agent_config_v2.py` 对齐。
 *
 * 提供 capabilities 嵌套字段的读 / 写 helper，避免业务代码到处写
 * `cfg?.capabilities?.overrides?.shell?.terminal_mode` 这种长 `?.` 链。
 */

import type {
  AgentConfig,
  CapabilityGroupId,
  CapabilityOverrides,
} from '../types/space-types.js'

/**
 * 读 ``config.capabilities.overrides.<capId>.<fieldName>``。
 *
 * 任何中间层缺失都返回 ``defaultValue``。
 *
 * @example
 * const tm = getCapabilityOverride(agentCfg, 'shell', 'terminal_mode', 'sandboxed')
 * const ops = getCapabilityOverride<Record<string, 'allow' | 'confirm' | 'block'>>(
 *   agentCfg, 'shell', 'operation_switches', {},
 * )
 */
export function getCapabilityOverride<T = unknown>(
  config: AgentConfig | null | undefined,
  capId: CapabilityGroupId,
  fieldName: string,
  defaultValue?: T,
): T | undefined {
  if (!config || typeof config !== 'object') return defaultValue
  const capabilities = config.capabilities
  if (!capabilities || typeof capabilities !== 'object') return defaultValue
  const overrides = capabilities.overrides
  if (!overrides || typeof overrides !== 'object') return defaultValue
  const capBlock = (overrides as Record<string, unknown>)[capId]
  if (!capBlock || typeof capBlock !== 'object') return defaultValue
  const val = (capBlock as Record<string, unknown>)[fieldName]
  return (val === undefined ? defaultValue : (val as T))
}

/**
 * 写 ``config.capabilities.overrides.<capId>.<fieldName> = value``。
 *
 * 自动补全中间层 dict（capabilities / overrides / cap block）。
 * **mutate** 入参 config —— 调用方应先 ``{ ...config }`` 浅拷贝。
 */
export function setCapabilityOverride(
  config: AgentConfig,
  capId: CapabilityGroupId,
  fieldName: string,
  value: unknown,
): AgentConfig {
  if (!config.capabilities) config.capabilities = {}
  if (!config.capabilities.overrides) config.capabilities.overrides = {}
  const overrides = config.capabilities.overrides as CapabilityOverrides &
    Record<string, Record<string, unknown> | undefined>
  if (!overrides[capId]) overrides[capId] = {}
  ;(overrides[capId] as Record<string, unknown>)[fieldName] = value
  return config
}

/**
 * 不可变版本：返回新 config（浅克隆嵌套路径），原 config 不变。
 *
 * 与 React state 设置兼容：
 * ```ts
 * setAgentCfg(prev => withCapabilityOverride(prev, 'shell', 'terminal_mode', 'regular'))
 * ```
 */
export function withCapabilityOverride(
  config: AgentConfig | null | undefined,
  capId: CapabilityGroupId,
  fieldName: string,
  value: unknown,
): AgentConfig {
  const next: AgentConfig = { ...(config ?? {}) }
  next.capabilities = { ...(next.capabilities ?? {}) }
  next.capabilities.overrides = { ...(next.capabilities.overrides ?? {}) }
  const overrides = next.capabilities.overrides as Record<
    string,
    Record<string, unknown> | undefined
  >
  overrides[capId] = { ...((overrides[capId] as Record<string, unknown> | undefined) ?? {}) }
  ;(overrides[capId] as Record<string, unknown>)[fieldName] = value
  return next
}

/**
 * 构造**仅含单个 capability override 字段**的最小 patch payload，用于
 * `updateAgent(id, { agent_config: patch })`。
 *
 * 与 ``withCapabilityOverride`` 的区别：后者把整包 config spread 进新对象
 * （会把 GET 拿到的老 DB 退役字段一并带回 PUT，触发 bleed-back / 未来 422）；
 * 本函数**只发变更子树**，靠 Django 端 ``_validate_and_merge_config`` 的
 * deep_merge 合并进库里现有 config。这样退役死数据不会被前端反复回写。
 *
 * @example
 * updateAgent(id, {
 *   agent_config: buildCapabilityOverridePatch('cost', 'execution_limits', {
 *     max_iterations_per_run: 200, max_credits_per_run: '5.0',
 *   }),
 * })
 */
export function buildCapabilityOverridePatch(
  capId: CapabilityGroupId,
  fieldName: string,
  value: unknown,
): AgentConfig {
  return {
    capabilities: { overrides: { [capId]: { [fieldName]: value } } },
  } as AgentConfig
}

// ─────────────────────────────────────────────────────────────────────
// CostCap 装配辅助（W2.3-fix · F8 修复）
// ─────────────────────────────────────────────────────────────────────

/**
 * Workspace / Agent `execution_limits` 读写形状。
 */
export interface ExecutionLimitsShape {
  enabled?: boolean | null
  max_iterations_per_run?: number | null
  max_credits_per_run?: string | number | null
}

/**
 * 是否存在任一数值型执行限制（旧数据兼容：无 `enabled` 时据此推断）。
 */
export function hasNumericExecutionLimits(
  limits: ExecutionLimitsShape | null | undefined,
): boolean {
  if (!limits) return false
  return limits.max_iterations_per_run != null || limits.max_credits_per_run != null
}

/**
 * ：执行限制是否启用。
 *
 * - 显式 `enabled: boolean` → 以其为准
 * - 缺省：任一 `max_*` 非 null → 视为启用（旧 Workspace 兼容）；否则禁用
 */
export function isExecutionLimitsEnabled(
  limits: ExecutionLimitsShape | null | undefined,
): boolean {
  if (!limits || typeof limits !== 'object') return false
  if (typeof limits.enabled === 'boolean') return limits.enabled
  return hasNumericExecutionLimits(limits)
}

/**
 * 归一后的 CostCap 执行限制 —— 与 `packages/agent-runtime/src/capability/governance/cost.ts`
 * 的 `CostCapExecutionLimits` 接口对齐，但**只接受 number 类型 max_credits**
 * （CostCap.afterIteration 用 `typeof === 'number'` 判定，string 不会触发）。
 */
export interface NormalizedCostExecutionLimits {
  max_iterations_per_run?: number
  max_credits_per_run?: number
}

/**
 * 把 v2 `agent_config.capabilities.overrides.cost.execution_limits` 子树
 * 归一到 CostCap 期望的 number 形态。
 *
 * **为什么需要归一**：
 * 1. Django `AgentService._validate_capability_overrides` 校验时把
 *    `max_credits_per_run` 字符串化（`str(min(mc, 10000.0))`，避免 JSON
 *    浮点精度问题），所以 v2 SSoT 里实际类型是 `string | null`（见
 *    `space-types.ts: CostCapabilityOverride`）。
 * 2. CostCap 期望 `number`：`afterIteration` 里写
 *    `typeof maxCredits === 'number' && maxCredits > 0`，string 不会触发
 *    `__force_final__` —— 用户配的 credits 上限因此**完全不生效**（W2 综合
 *    独立验证 P0，F8 失败反思）。
 * 3. `max_iterations_per_run` 在 v2 是 `number | null`，本来就该是 number；
 *    null / 0 / 负数视作"未配置"。
 *
 * **使用场景**：两宿主（ElectronAgentHost / DaemonAgentHost）`createRuntime`
 * 装配 CostCap 时把已经从 v2 读出的 execution_limits 子树喂给本函数，
 * 拿到的 number 形态直接塞进 `CostCapInit.config.execution_limits`。
 *
 * **行为**：
 * - 输入非对象 / null / undefined → 返回 undefined
 * - max_iterations_per_run 必须是 number 且 ≥ 1，否则不写入
 * - max_credits_per_run 接受 number 或数字 string；必须 > 0；否则不写入
 *   （0 / 负数视作"未配置"，与 Django 校验后 `el['max_credits_per_run'] = None`
 *   的语义对齐）
 * - 全字段都缺省 → 返回 undefined（让两宿主 inline 装配代码可以
 *   `?.max_iterations_per_run` 安全访问）
 *
 * @param raw v2 read 出的 execution_limits 子树（`getCapabilityOverride(cfg, 'cost', 'execution_limits')` 的返回值）
 *
 * @example
 * // 典型 v2 配置（Django 校验后）
 * normalizeExecutionLimitsForCostCap({
 *   max_iterations_per_run: 200,
 *   max_credits_per_run: '5.0',  // Django stringify 后
 * })
 * // → { max_iterations_per_run: 200, max_credits_per_run: 5.0 }
 *
 * @example
 * // v1 / 缺省 / 脏数据
 * normalizeExecutionLimitsForCostCap(undefined)            // → undefined
 * normalizeExecutionLimitsForCostCap({})                   // → undefined
 * normalizeExecutionLimitsForCostCap({ max_credits_per_run: null })  // → undefined
 * normalizeExecutionLimitsForCostCap({ max_credits_per_run: 'abc' }) // → undefined
 */
export function normalizeExecutionLimitsForCostCap(
  raw: unknown,
): NormalizedCostExecutionLimits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  // ：显式关闭时不向 CostCap 注入任何上限（即使残留了旧数字草稿）。
  if (obj.enabled === false) return undefined

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
