import { describe, expect, it, beforeEach } from 'vitest'
import {
  isCurrentPreferredModelEpoch,
  isPersistablePreferredModelId,
  nextPreferredModelEpoch,
  resetPreferredModelWriteEpochsForTests,
} from './preferred-model-write.js'

describe('preferred-model-write', () => {
  beforeEach(() => {
    resetPreferredModelWriteEpochsForTests()
  })

  it('只接受平台模型 UUID 作为可持久化 preferred', () => {
    expect(isPersistablePreferredModelId('42ae58c8-feea-4098-b80b-9a0aedc35007')).toBe(true)
    expect(isPersistablePreferredModelId('gpt-5.6-sol')).toBe(false)
    expect(isPersistablePreferredModelId('')).toBe(false)
    expect(isPersistablePreferredModelId('  ')).toBe(false)
  })

  it('per-agent epoch 递增，跨 agent 独立', () => {
    expect(nextPreferredModelEpoch('a1')).toBe(1)
    expect(nextPreferredModelEpoch('a1')).toBe(2)
    expect(nextPreferredModelEpoch('a2')).toBe(1)
    expect(isCurrentPreferredModelEpoch('a1', 2)).toBe(true)
    expect(isCurrentPreferredModelEpoch('a1', 1)).toBe(false)
  })
})
