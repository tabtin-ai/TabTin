/**
 * 跨轮记忆 · feature flag 单测。
 *
 * 直接测试 @tabtin/agent-runtime/history 的 isCrossTurnMemoryEnabled，
 * 通过 envReader 参数注入 mock 环境值。
 */

import { describe, expect, it } from 'vitest'
import { isCrossTurnMemoryEnabled } from '@tabtin/agent-runtime/history'

describe('isCrossTurnMemoryEnabled', () => {
  it('默认（未配置 agent_config、无 envReader）→ true', () => {
    expect(isCrossTurnMemoryEnabled(undefined)).toBe(true)
    expect(isCrossTurnMemoryEnabled({})).toBe(true)
    expect(isCrossTurnMemoryEnabled(null)).toBe(true)
  })

  it('agent_config.cross_turn_memory === false → false（单 Agent 豁免）', () => {
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: false })).toBe(false)
  })

  it('agent_config.cross_turn_memory === true → true', () => {
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: true })).toBe(true)
  })

  it('envReader 返回 "1" → 紧急 kill switch，强制 false', () => {
    const reader = () => '1'
    expect(isCrossTurnMemoryEnabled(undefined, reader)).toBe(false)
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: true }, reader)).toBe(false)
  })

  it('envReader 返回 "TRUE"（大小写不敏感）→ false', () => {
    expect(isCrossTurnMemoryEnabled(undefined, () => 'TRUE')).toBe(false)
  })

  it('envReader 返回 "0" / "false" / 空 → 不触发 kill switch', () => {
    expect(isCrossTurnMemoryEnabled(undefined, () => '0')).toBe(true)
    expect(isCrossTurnMemoryEnabled(undefined, () => 'false')).toBe(true)
    expect(isCrossTurnMemoryEnabled(undefined, () => '')).toBe(true)
  })

  it('env 优先级 > agent_config', () => {
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: true }, () => '1')).toBe(false)
  })

  it('envReader 抛错 → 不炸链路，走下级判定', () => {
    const throwingReader = () => { throw new Error('env broken') }
    expect(isCrossTurnMemoryEnabled(undefined, throwingReader)).toBe(true)
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: false }, throwingReader)).toBe(false)
  })

  it('无 envReader（Daemon 场景）→ 跳过 env 层，只看 agent_config', () => {
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: false })).toBe(false)
    expect(isCrossTurnMemoryEnabled({ cross_turn_memory: true })).toBe(true)
    expect(isCrossTurnMemoryEnabled(undefined)).toBe(true)
  })
})
