import { describe, expect, it } from 'vitest'
import {
  PERFORMANCE_BY_MODEL_KEY,
  THINKING_BY_MODEL_KEY,
  applyRuntimeProfileForModel,
  retainRuntimeProfileByModelAfterServerPersist,
  seedRuntimeProfileMapsFromLegacy,
  writePerformanceForModel,
  writeThinkingForModel,
} from './runtimeProfileByModel'

describe('runtimeProfileByModel', () => {
  it('seeds legacy session thinking onto previous model map', () => {
    const seeded = seedRuntimeProfileMapsFromLegacy(
      { v: 2, thinking_mode: 'deep', performance_profile: 'fast' },
      'model-a',
    )
    expect(JSON.parse(String(seeded[THINKING_BY_MODEL_KEY]))).toEqual({
      'model-a': 'deep',
    })
    expect(JSON.parse(String(seeded[PERFORMANCE_BY_MODEL_KEY]))).toEqual({
      'model-a': 'fast',
    })
  })

  it('apply clears thinking/performance when target model has no map entry', () => {
    const seeded = seedRuntimeProfileMapsFromLegacy(
      { v: 2, thinking_mode: 'deep', performance_profile: 'quality' },
      'model-a',
    )
    const onB = applyRuntimeProfileForModel(seeded, 'model-b')
    expect(onB.thinking_mode).toBeUndefined()
    expect(onB.performance_profile).toBeUndefined()
    expect(JSON.parse(String(onB[THINKING_BY_MODEL_KEY]))).toEqual({
      'model-a': 'deep',
    })
  })

  it('write + apply restores per-model thinking without bleeding', () => {
    let overrides = writeThinkingForModel({}, 'evolving', 'deep')
    overrides = applyRuntimeProfileForModel(overrides, 'lite')
    expect(overrides.thinking_mode).toBeUndefined()

    overrides = writeThinkingForModel(overrides, 'lite', 'standard')
    expect(overrides.thinking_mode).toBe('standard')

    overrides = applyRuntimeProfileForModel(overrides, 'evolving')
    expect(overrides.thinking_mode).toBe('deep')
  })

  it('write performance is isolated by model', () => {
    let overrides = writePerformanceForModel({}, 'm1', 'fast')
    overrides = applyRuntimeProfileForModel(overrides, 'm2')
    expect(overrides.performance_profile).toBeUndefined()
    overrides = applyRuntimeProfileForModel(overrides, 'm1')
    expect(overrides.performance_profile).toBe('fast')
  })

  it('retains by-model maps after server strips them', () => {
    const local = writeThinkingForModel(
      { v: 2, thinking_mode: 'deep' },
      'm1',
      'deep',
    )
    const retained = retainRuntimeProfileByModelAfterServerPersist(
      { v: 2, thinking_mode: 'deep' },
      local,
    )
    expect(retained[THINKING_BY_MODEL_KEY]).toBe(local[THINKING_BY_MODEL_KEY])
  })
})
