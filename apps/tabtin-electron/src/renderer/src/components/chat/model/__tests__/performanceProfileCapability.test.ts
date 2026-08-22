import { describe, expect, it } from 'vitest'
import type { Model } from '@tabtin/chat-client'
import {
  DEFAULT_PERFORMANCE_PROFILE,
  isPerformanceCapabilitySupported,
  performanceProfileControlChange,
  resolveActivePerformanceProfile,
} from '../performanceProfileCapability'

describe('performanceProfileCapability', () => {
  it('gates UI on runtime_profile.performance.supported === true only', () => {
    expect(isPerformanceCapabilitySupported(null)).toBe(false)
    expect(isPerformanceCapabilitySupported({} as Model)).toBe(false)
    expect(isPerformanceCapabilitySupported({
      runtime_profile: {
        thinking: { supported: true, modes: ['standard'], default_mode: 'standard' },
      },
    } as Model)).toBe(false)
    expect(isPerformanceCapabilitySupported({
      runtime_profile: {
        thinking: { supported: true, modes: ['standard'], default_mode: 'standard' },
        performance: { supported: false },
      },
    } as Model)).toBe(false)
    expect(isPerformanceCapabilitySupported({
      runtime_profile: {
        thinking: { supported: true, modes: ['standard'], default_mode: 'standard' },
        performance: { supported: true },
      },
    } as Model)).toBe(true)
  })

  it('defaults to balanced when missing or invalid', () => {
    expect(resolveActivePerformanceProfile(null)).toBe(DEFAULT_PERFORMANCE_PROFILE)
    expect(resolveActivePerformanceProfile({})).toBe('balanced')
    expect(resolveActivePerformanceProfile({ performance_profile: 'turbo' })).toBe('balanced')
    expect(resolveActivePerformanceProfile({ performance_profile: 'speed' })).toBe('balanced')
  })

  it('reads performance_profile from overrides', () => {
    expect(
      resolveActivePerformanceProfile({ v: 2, performance_profile: 'quality' }),
    ).toBe('quality')
    expect(
      resolveActivePerformanceProfile({ performance_profile: 'FAST' }),
    ).toBe('fast')
  })

  it('writes only performance_profile key', () => {
    expect(performanceProfileControlChange('fast')).toEqual({
      key: 'performance_profile',
      value: 'fast',
    })
    expect(JSON.stringify(performanceProfileControlChange('quality')))
      .not.toMatch(/response_mode|answer_mode|speed_mode|"speed"/)
  })

  it('coexists with thinking_mode without touching it', () => {
    const overrides = { v: 2 as const, thinking_mode: 'deep' as const, performance_profile: 'fast' as const }
    expect(resolveActivePerformanceProfile(overrides)).toBe('fast')
    expect(overrides.thinking_mode).toBe('deep')
  })
})
