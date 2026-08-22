import { describe, expect, it } from 'vitest'
import { buildCostCapConfig } from '../src/runtime/cost-cap-config.js'

describe('buildCostCapConfig', () => {
  const resolveContextWindow = (_model: string) => 128_000

  it('carries stringified max_credits_per_run into a number (Django stringify path)', () => {
    const result = buildCostCapConfig({
      executionLimits: { max_iterations_per_run: 200, max_credits_per_run: '5.0' },
      contextWindowTokens: 32_000,
      resolveContextWindow,
    })
    expect(result.config.execution_limits.max_iterations_per_run).toBe(200)
    expect(result.config.execution_limits.max_credits_per_run).toBe(5)
    expect(result.contextWindowTokens).toBe(32_000)
    expect(result.resolveContextWindow).toBe(resolveContextWindow)
  })

  it('drops null / undefined / dirty inputs to undefined (CostCap falls back to default)', () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      { max_credits_per_run: null },
      { max_credits_per_run: 'abc' },
      { max_credits_per_run: 0 },
      { max_credits_per_run: -1 },
      { max_iterations_per_run: 0 },
      { max_iterations_per_run: -3 },
    ]
    for (const raw of cases) {
      const result = buildCostCapConfig({
        executionLimits: raw as never,
        contextWindowTokens: 32_000,
        resolveContextWindow,
      })
      expect(result.config.execution_limits.max_credits_per_run).toBeUndefined()
    }
  })

  it('floors fractional iterations and trims stringified credits', () => {
    const result = buildCostCapConfig({
      executionLimits: {
        max_iterations_per_run: 200.9,
        max_credits_per_run: '  12.5  ',
      },
      contextWindowTokens: 32_000,
      resolveContextWindow,
    })
    expect(result.config.execution_limits.max_iterations_per_run).toBe(200)
    expect(result.config.execution_limits.max_credits_per_run).toBe(12.5)
  })

  it('exposes resolver identity (host wiring passes dynamicResolveContextWindow directly)', () => {
    const custom = (_model: string) => 200_000
    const result = buildCostCapConfig({
      contextWindowTokens: 32_000,
      resolveContextWindow: custom,
    })
    expect(result.resolveContextWindow).toBe(custom)
    expect(result.config.execution_limits.max_iterations_per_run).toBeUndefined()
    expect(result.config.execution_limits.max_credits_per_run).toBeUndefined()
  })
})
