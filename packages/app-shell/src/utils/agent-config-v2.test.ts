/**
 * agent_config v2 工具函数单测（W2.3-fix · F8 修复）
 *
 * 重点覆盖 `normalizeExecutionLimitsForCostCap` —— W2 综合独立验证 P0
 * 接线 bug 的根因修复：v2 `cost.execution_limits.max_credits_per_run`
 * 在 Django 校验后是 string，而 CostCap.afterIteration 用 `typeof === 'number'`
 * 判定 → 不归一就永远不触发 `__force_final__`。
 *
 * 三种关键场景（与 W2.3-fix prompt Stage 3 对齐）：
 *   1. v2 配置 → 接到 v2 值（含 string max_credits 接受）
 *   2. v1 配置（缺 capabilities.overrides.cost）→ undefined fallback（不崩）
 *   3. max_credits=100 + 累计超 100 → CostCap.afterIteration 真触发
 *      `__force_final__`（已在 cost.test.ts line 339-369 覆盖；这里
 *      验证 helper → CostCap 链路通畅）
 */
import { describe, expect, it } from 'vitest'
import {
  getCapabilityOverride,
  setCapabilityOverride,
  withCapabilityOverride,
  buildCapabilityOverridePatch,
  normalizeExecutionLimitsForCostCap,
} from './agent-config-v2.js'
import type { AgentConfig } from '../types/space-types.js'

// ─── getCapabilityOverride / setCapabilityOverride / withCapabilityOverride ───

describe('getCapabilityOverride', () => {
  it('正常路径读到值', () => {
    const cfg: AgentConfig = {
      capabilities: {
        overrides: { shell: { terminal_mode: 'sandboxed' } },
      },
    }
    expect(getCapabilityOverride(cfg, 'shell', 'terminal_mode')).toBe('sandboxed')
  })

  it('中间层缺失返回 default', () => {
    expect(getCapabilityOverride(undefined, 'cost', 'execution_limits', 'X')).toBe('X')
    expect(getCapabilityOverride({}, 'cost', 'execution_limits', 'X')).toBe('X')
    expect(
      getCapabilityOverride({ capabilities: {} }, 'cost', 'execution_limits', 'X'),
    ).toBe('X')
  })

  it('null config 返回 default', () => {
    expect(getCapabilityOverride(null, 'shell', 'terminal_mode', 'fallback')).toBe(
      'fallback',
    )
  })
})

describe('setCapabilityOverride / withCapabilityOverride', () => {
  it('set 自动补全中间层', () => {
    const cfg: AgentConfig = {}
    setCapabilityOverride(cfg, 'cost', 'execution_limits', { max_iterations_per_run: 100 })
    expect(cfg.capabilities?.overrides?.cost?.execution_limits?.max_iterations_per_run).toBe(
      100,
    )
  })

  it('with 不可变（不 mutate 原 config）', () => {
    const original: AgentConfig = { capabilities: { overrides: {} } }
    const next = withCapabilityOverride(original, 'shell', 'terminal_mode', 'regular')
    expect(original.capabilities?.overrides?.shell).toBeUndefined()
    expect(next.capabilities?.overrides?.shell?.terminal_mode).toBe('regular')
  })
})

describe('buildCapabilityOverridePatch', () => {
  it('只产出单字段最小子树（不含其他顶层字段）', () => {
    const patch = buildCapabilityOverridePatch('cost', 'execution_limits', {
      max_iterations_per_run: 200,
      max_credits_per_run: '5.0',
    })
    expect(patch).toEqual({
      capabilities: {
        overrides: {
          cost: {
            execution_limits: {
              max_iterations_per_run: 200,
              max_credits_per_run: '5.0',
            },
          },
        },
      },
    })
  })

  it('不携带任何旧 config / 退役字段（阶段2 源头收口核心）', () => {
    const patch = buildCapabilityOverridePatch('cost', 'execution_limits', {})
    // 顶层只有 capabilities，没有 security / authorization_preset / soul 等回写来源
    expect(Object.keys(patch)).toEqual(['capabilities'])
  })
})

// ─── normalizeExecutionLimitsForCostCap (W2.3-fix 核心) ─────────────

describe('normalizeExecutionLimitsForCostCap', () => {
  // ─ 场景 1：v2 配置完整（典型 Django 校验后形态）─

  it('v2 完整配置（max_iterations + string max_credits）→ 归一到 number', () => {
    const r = normalizeExecutionLimitsForCostCap({
      max_iterations_per_run: 200,
      max_credits_per_run: '5.0',
    })
    expect(r).toEqual({ max_iterations_per_run: 200, max_credits_per_run: 5.0 })
  })

  it('v2 仅配 max_iterations（max_credits null）→ 只接 max_iterations', () => {
    const r = normalizeExecutionLimitsForCostCap({
      max_iterations_per_run: 100,
      max_credits_per_run: null,
    })
    expect(r).toEqual({ max_iterations_per_run: 100 })
  })

  it('v2 仅配 max_credits（string，max_iterations null）→ 只接 max_credits', () => {
    const r = normalizeExecutionLimitsForCostCap({
      max_iterations_per_run: null,
      max_credits_per_run: '2.5',
    })
    expect(r).toEqual({ max_credits_per_run: 2.5 })
  })

  it('max_credits 是 number 直接接受', () => {
    const r = normalizeExecutionLimitsForCostCap({
      max_credits_per_run: 1.0,
    })
    expect(r).toEqual({ max_credits_per_run: 1.0 })
  })

  // ─ 场景 2：v1 / 缺省 / 脏数据 → undefined fallback ─

  it('入参 undefined → undefined', () => {
    expect(normalizeExecutionLimitsForCostCap(undefined)).toBeUndefined()
  })

  it('入参 null → undefined', () => {
    expect(normalizeExecutionLimitsForCostCap(null)).toBeUndefined()
  })

  it('入参非对象（数组 / 数字 / 字符串）→ undefined', () => {
    expect(normalizeExecutionLimitsForCostCap([])).toBeUndefined()
    expect(normalizeExecutionLimitsForCostCap(42)).toBeUndefined()
    expect(normalizeExecutionLimitsForCostCap('whatever')).toBeUndefined()
  })

  it('空对象 → undefined（避免装配点 ?? 空对象误判已配置）', () => {
    expect(normalizeExecutionLimitsForCostCap({})).toBeUndefined()
  })

  it('#8910 enabled:false → 即使有数值也不注入 CostCap', () => {
    expect(
      normalizeExecutionLimitsForCostCap({
        enabled: false,
        max_iterations_per_run: 200,
        max_credits_per_run: '5.0',
      }),
    ).toBeUndefined()
  })

  it('全字段 null（v2 default 形态）→ undefined', () => {
    expect(
      normalizeExecutionLimitsForCostCap({
        max_iterations_per_run: null,
        max_credits_per_run: null,
      }),
    ).toBeUndefined()
  })

  it('max_credits 是非数字 string → 该字段静默丢弃', () => {
    expect(
      normalizeExecutionLimitsForCostCap({ max_credits_per_run: 'abc' }),
    ).toBeUndefined()
  })

  it('max_credits 是空字符串 → 静默丢弃', () => {
    expect(
      normalizeExecutionLimitsForCostCap({ max_credits_per_run: '' }),
    ).toBeUndefined()
  })

  it('max_credits 是 0 / 负数 → 视作未配置（与 Django 校验对齐）', () => {
    expect(normalizeExecutionLimitsForCostCap({ max_credits_per_run: 0 })).toBeUndefined()
    expect(normalizeExecutionLimitsForCostCap({ max_credits_per_run: -1 })).toBeUndefined()
    expect(normalizeExecutionLimitsForCostCap({ max_credits_per_run: '0' })).toBeUndefined()
    expect(normalizeExecutionLimitsForCostCap({ max_credits_per_run: '-5.0' })).toBeUndefined()
  })

  it('max_iterations 非数字 / 0 / 负数 → 视作未配置', () => {
    expect(
      normalizeExecutionLimitsForCostCap({ max_iterations_per_run: 0 }),
    ).toBeUndefined()
    expect(
      normalizeExecutionLimitsForCostCap({ max_iterations_per_run: -10 }),
    ).toBeUndefined()
    expect(
      normalizeExecutionLimitsForCostCap({ max_iterations_per_run: '100' as unknown }),
    ).toBeUndefined()
    expect(
      normalizeExecutionLimitsForCostCap({ max_iterations_per_run: NaN }),
    ).toBeUndefined()
  })

  it('max_iterations 是浮点 → 取 floor', () => {
    const r = normalizeExecutionLimitsForCostCap({ max_iterations_per_run: 99.7 })
    expect(r).toEqual({ max_iterations_per_run: 99 })
  })

  // ─ 场景 3：v2 → CostCap 链路通（与 cost.test.ts 阈值测试形成端到端值流验证）─

  it('归一后的 max_credits 直接喂给 CostCap.execution_limits 应能让 afterIteration 触发', async () => {
    // 此测试是"端到端值流"断言：归一函数输出 → CostCap 期望形态。
    // 真正的 afterIteration 触发逻辑由 cost.test.ts 覆盖。
    // 这里只验证：v2 string max_credits 经本 helper 归一后，类型是 CostCap
    // 期望的 number，且数值正确（如果不归一，CostCap 内部 typeof 判断
    // 会丢这个值 → __force_final__ 永远不触发 → 这就是 F8 P0 的根因）。
    const v2RawFromDjango = {
      max_iterations_per_run: 50,
      max_credits_per_run: '100.0', // Django 校验后是 string
    }
    const normalized = normalizeExecutionLimitsForCostCap(v2RawFromDjango)
    expect(normalized).toBeDefined()
    expect(typeof normalized!.max_credits_per_run).toBe('number')
    expect(normalized!.max_credits_per_run).toBe(100.0)
    // typeof === 'number' 判断在 CostCap.afterIteration line 380:
    //   if (typeof maxCredits === 'number' && maxCredits > 0) { ... }
    // 归一后该判断为真 → __force_final__ 路径解锁
    expect(typeof normalized!.max_credits_per_run === 'number').toBe(true)
  })
})
