/**
 * Wave 6 二次续作 NEW-P1-4 — trackerRun.recovery* i18n key 存在性 + 双语真翻译。
 *
 * 反思 14 教训:i18n 加 key 不能只塞中文 / 只塞 fallback,必须双语都真翻译,
 * 否则切英文渲染时仍是中文,看似工作实际是死字段。
 */

import { describe, it, expect } from 'vitest'

import zhChat from '../locales/zh-CN/chat.json'
import enChat from '../locales/en-US/chat.json'

const REQUIRED_KEYS = [
  'recoveryRerunSuccess',
  'recoveryRedirect',
  'recoveryFailed',
] as const

describe('trackerRun.recovery* i18n keys (NEW-P1-4)', () => {
  it('zh-CN 三个新 key 都存在且非空', () => {
    const tr = (zhChat as any).trackerRun
    expect(tr).toBeDefined()
    for (const k of REQUIRED_KEYS) {
      expect(tr[k]).toBeTruthy()
      expect(typeof tr[k]).toBe('string')
      expect((tr[k] as string).trim().length).toBeGreaterThan(0)
    }
  })

  it('en-US 三个新 key 都存在且非空', () => {
    const tr = (enChat as any).trackerRun
    expect(tr).toBeDefined()
    for (const k of REQUIRED_KEYS) {
      expect(tr[k]).toBeTruthy()
      expect(typeof tr[k]).toBe('string')
      expect((tr[k] as string).trim().length).toBeGreaterThan(0)
    }
  })

  it('en-US 必须是真英文(不是 fallback 中文)— 反思 14 防线', () => {
    const tr = (enChat as any).trackerRun
    for (const k of REQUIRED_KEYS) {
      const v = tr[k] as string
      // 简单启发式:英文文案不应包含 CJK 字符
      // (否则就是没翻译,只是塞了中文 fallback)
      expect(v).not.toMatch(/[一-鿿]/)
    }
  })

  it('recoveryFailed 含 {{msg}} 占位符(双语对齐)', () => {
    expect((zhChat as any).trackerRun.recoveryFailed).toContain('{{msg}}')
    expect((enChat as any).trackerRun.recoveryFailed).toContain('{{msg}}')
  })

  it('与自动化 RunStatusIndicator 实际 t() 调用的 key 名一致', () => {
    // 防止后续重命名 key 导致 fallback 默认值生效但翻译丢失
    const tr = (zhChat as any).trackerRun
    expect(tr.recoveryRerunSuccess).toBe('已重新触发')
    expect(tr.recoveryRedirect).toBe('请到自动化任务详情页继续操作')
    expect(tr.recoveryFailed).toBe('操作失败:{{msg}}')
  })
})
