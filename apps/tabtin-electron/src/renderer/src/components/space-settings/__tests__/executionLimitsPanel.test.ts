import { describe, expect, it } from 'vitest'
import { buildCapabilityOverridePatch } from '@tabtin/app-shell/agent-config-v2'
import {
  DEFAULT_MAX_CREDITS_PER_RUN,
  DEFAULT_MAX_TURNS,
} from '@tabtin/agent-runtime/runtime-defaults'
import {
  hasCustomExecutionLimits,
  isExecutionLimitsEnabled,
  normalizeExecutionLimitsForPersist,
  PRODUCT_DEFAULT_MAX_CREDITS,
  PRODUCT_DEFAULT_MAX_ITERATIONS,
  resolveExecutionLimitsDisplay,
} from '../executionLimitsHelpers'

describe('isExecutionLimitsEnabled ', () => {
  it('空/未设 → 禁用', () => {
    expect(isExecutionLimitsEnabled(undefined)).toBe(false)
    expect(isExecutionLimitsEnabled({})).toBe(false)
    expect(isExecutionLimitsEnabled({
      max_iterations_per_run: null,
      max_credits_per_run: null,
    })).toBe(false)
  })

  it('显式 enabled 优先于数值', () => {
    expect(isExecutionLimitsEnabled({ enabled: false, max_iterations_per_run: 100 })).toBe(false)
    expect(isExecutionLimitsEnabled({ enabled: true })).toBe(true)
  })

  it('旧数据：无 enabled 但有数值 → 视为启用', () => {
    expect(isExecutionLimitsEnabled({ max_iterations_per_run: 100 })).toBe(true)
    expect(isExecutionLimitsEnabled({ max_credits_per_run: '5' })).toBe(true)
  })
})

describe('hasCustomExecutionLimits', () => {
  it('空/未设 → 视为无数值', () => {
    expect(hasCustomExecutionLimits(undefined)).toBe(false)
    expect(hasCustomExecutionLimits({})).toBe(false)
    expect(hasCustomExecutionLimits({
      max_iterations_per_run: null,
      max_credits_per_run: null,
    })).toBe(false)
  })

  it('任一字段有值 → 视为有数值', () => {
    expect(hasCustomExecutionLimits({ max_iterations_per_run: 100 })).toBe(true)
    expect(hasCustomExecutionLimits({ max_credits_per_run: '5' })).toBe(true)
  })
})

describe('resolveExecutionLimitsDisplay ', () => {
  it('UI 常量与 agent-runtime SSoT 同源（防再漂）', () => {
    expect(PRODUCT_DEFAULT_MAX_ITERATIONS).toBe(DEFAULT_MAX_TURNS)
    expect(PRODUCT_DEFAULT_MAX_CREDITS).toBe(String(DEFAULT_MAX_CREDITS_PER_RUN))
    expect(PRODUCT_DEFAULT_MAX_ITERATIONS).toBe(500)
    expect(PRODUCT_DEFAULT_MAX_CREDITS).toBe('1000')
  })

  it('缺省/null → 面板展示推荐初值（不代表已启用）', () => {
    expect(resolveExecutionLimitsDisplay(undefined)).toEqual({
      maxIterations: '500',
      maxCredits: '1000',
    })
    expect(resolveExecutionLimitsDisplay({
      max_iterations_per_run: null,
      max_credits_per_run: null,
    })).toEqual({
      maxIterations: '500',
      maxCredits: '1000',
    })
  })

  it('显式配置 → 原样展示', () => {
    expect(resolveExecutionLimitsDisplay({
      max_iterations_per_run: 30,
      max_credits_per_run: '10',
    })).toEqual({
      maxIterations: '30',
      maxCredits: '10',
    })
  })
})

describe('normalizeExecutionLimitsForPersist ', () => {
  it('等于推荐初值 → 仍存字面值（不塌 null，尊重显式设置）', () => {
    expect(normalizeExecutionLimitsForPersist('500', '1000')).toEqual({
      iterValue: 500,
      credValue: '1000',
    })
  })

  it('自定义值 → 原样持久化', () => {
    expect(normalizeExecutionLimitsForPersist('30', '10')).toEqual({
      iterValue: 30,
      credValue: '10',
    })
  })

  it('空串 / 非法 → invalid', () => {
    expect(normalizeExecutionLimitsForPersist('', '50')).toEqual({ error: 'invalid' })
    expect(normalizeExecutionLimitsForPersist('200', '')).toEqual({ error: 'invalid' })
    expect(normalizeExecutionLimitsForPersist('0', '50')).toEqual({ error: 'invalid' })
    expect(normalizeExecutionLimitsForPersist('200', '0')).toEqual({ error: 'invalid' })
  })
})

describe('execution limits reset patch ', () => {
  it('恢复默认应写 null 子树，供后端 deep_merge 清掉 override', () => {
    const patch = buildCapabilityOverridePatch('cost', 'execution_limits', {
      max_iterations_per_run: null,
      max_credits_per_run: null,
    })
    expect(patch).toEqual({
      capabilities: {
        overrides: {
          cost: {
            execution_limits: {
              max_iterations_per_run: null,
              max_credits_per_run: null,
            },
          },
        },
      },
    })
  })
})
