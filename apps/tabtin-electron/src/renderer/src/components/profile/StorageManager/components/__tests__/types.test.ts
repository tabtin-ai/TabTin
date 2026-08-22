/**
 * resolveAffordanceLevel 守护测试 — D-4 四档映射的纯函数级守护。
 */

import { describe, it, expect } from 'vitest'
import { resolveAffordanceLevel, formatBytes } from '../types'

describe('resolveAffordanceLevel (D-4 守护)', () => {
  it('cache + none → L1', () => {
    expect(
      resolveAffordanceLevel({
        category: 'cache',
        requiresConfirmation: 'none',
        group: 'cache',
      }),
    ).toBe('L1')
  })

  it('semi-cache + soft → L2', () => {
    expect(
      resolveAffordanceLevel({
        category: 'semi-cache',
        requiresConfirmation: 'soft',
        group: 'cache',
      }),
    ).toBe('L2')
  })

  it('data + soft → L3-soft（任何 group）', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'soft',
        group: 'business-app',
      }),
    ).toBe('L3-soft')
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'soft',
        group: 'login',
      }),
    ).toBe('L3-soft')
  })

  it('data + hard + login → L4', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'login',
      }),
    ).toBe('L4')
  })

  it('data + hard + system → L4', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'system',
      }),
    ).toBe('L4')
  })

  it('data + hard + business-app → L3-hard（非 login/system）', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'business-app',
      }),
    ).toBe('L3-hard')
  })

  it('data + hard + conversation → L3-hard', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'conversation',
      }),
    ).toBe('L3-hard')
  })

  it('data + hard + checkpoint → L3-hard', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'checkpoint',
      }),
    ).toBe('L3-hard')
  })

  it('data + hard + browser → L3-hard', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'browser',
      }),
    ).toBe('L3-hard')
  })

  it('data + hard + media → L3-hard', () => {
    expect(
      resolveAffordanceLevel({
        category: 'data',
        requiresConfirmation: 'hard',
        group: 'media',
      }),
    ).toBe('L3-hard')
  })
})

describe('formatBytes（W3.1 + W3.2 共用同一实现）', () => {
  // 注：W3.1 formatBytes 规则——"小于 10 显示一位小数、否则取整"
  it('零或负数 → "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(-100)).toBe('0 B')
  })

  it('< 1KB → 显示 B', () => {
    expect(formatBytes(512)).toBe('512 B')
  })

  it('1 KB 边界（W3.1 规则：< 10 显示一位小数）', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
  })

  it('100 KB（>= 10 取整）', () => {
    expect(formatBytes(1024 * 100)).toBe('100 KB')
  })

  it('1 MB 边界（W3.1 规则：< 10 显示一位小数）', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
  })

  it('50 MB（>= 10 取整）', () => {
    expect(formatBytes(1024 * 1024 * 50)).toBe('50 MB')
  })

  it('1 GB 边界', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('2.5 GB', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe('2.5 GB')
  })
})
