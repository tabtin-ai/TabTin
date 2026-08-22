/**
 * @tabtin/desktop-native —— "包能 import"级别守约（规范 § 9.1 完成标准 3）。
 *
 * 模块零阶段验证：
 * 1. `loadNativeBinding()` 返回 null（fallback）
 * 2. `hasNativeBinding()` 返回 false
 * 3. `getDesktopNativeCapabilities()` 返回全 unavailable 的 fallback 形态
 * 4. 占位 Swift 文件 + CMakeLists 模板存在（grep 验收锚点）
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  hasNativeBinding,
  loadNativeBinding,
  getDesktopNativeCapabilities,
  FALLBACK_DESKTOP_NATIVE_CAPABILITIES,
} from '../index.js'

const __filename = fileURLToPath(import.meta.url)
// `src/__tests__/desktop-native.test.ts` → 包根 `../../`
const PACKAGE_ROOT = join(dirname(__filename), '..', '..')

describe('@tabtin/desktop-native · 包初始化（v2.1 模块零）', () => {
  it('loadNativeBinding() 返回 null（fallback 不抛错）', () => {
    const binding = loadNativeBinding()
    expect(binding).toBeNull()
  })

  it('hasNativeBinding() 返回 false（模块零阶段未启用 native）', () => {
    expect(hasNativeBinding()).toBe(false)
  })

  it('getDesktopNativeCapabilities() 返回全 unavailable + source=fallback', () => {
    const caps = getDesktopNativeCapabilities()
    expect(caps.escCGEventTapPI).toBe('unavailable')
    expect(caps.scContentFilter).toBe('unavailable')
    expect(caps.axUIElementTree).toBe('unavailable')
    expect(caps.source).toBe('fallback')
  })

  it('FALLBACK_DESKTOP_NATIVE_CAPABILITIES 是常量导出（消费方可直接 import）', () => {
    // 不修改默认对象 → 调用方 mutate 后续调用受影响——所以 getDesktopNativeCapabilities
    // 必须返回浅拷贝；直接断言 fallback 常量字段稳定。
    expect(FALLBACK_DESKTOP_NATIVE_CAPABILITIES.escCGEventTapPI).toBe('unavailable')
    expect(FALLBACK_DESKTOP_NATIVE_CAPABILITIES.source).toBe('fallback')
  })

  it('getDesktopNativeCapabilities 返回浅拷贝（避免外部 mutate 污染常量）', () => {
    const a = getDesktopNativeCapabilities()
    a.escCGEventTapPI = 'native'
    const b = getDesktopNativeCapabilities()
    expect(b.escCGEventTapPI).toBe('unavailable')
  })
})

describe('@tabtin/desktop-native · 占位文件存在（grep 验收锚点）', () => {
  it('占位 Swift 源文件存在 native/swift/HelloWorld.swift', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'native', 'swift', 'HelloWorld.swift'))).toBe(true)
  })

  it('CMakeLists 工程模板存在 native/CMakeLists.txt.template', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'native', 'CMakeLists.txt.template'))).toBe(true)
  })

  it('README.md 存在并描述模块零阶段范围', () => {
    expect(existsSync(join(PACKAGE_ROOT, 'README.md'))).toBe(true)
  })
})
