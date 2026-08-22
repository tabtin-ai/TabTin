import { describe, expect, it } from 'vitest'
import enUS from '../../renderer/src/i18n/locales/en-US/tabslide.json'
import zhCN from '../../renderer/src/i18n/locales/zh-CN/tabslide.json'

function collectLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      keys.push(...collectLeafKeys(v as Record<string, unknown>, path))
    } else {
      keys.push(path)
    }
  }
  return keys.sort()
}

describe('TabSlide i18n key 一致性', () => {
  it('en-US 的 message 节应包含 saveError 键 (I18N-04)', () => {
    const enMessage = (enUS as Record<string, Record<string, string>>).message
    expect(enMessage).toBeDefined()
    expect(enMessage.saveError).toBe('Save failed')
  })

  it('zh-CN 的 message 节应包含 saveError 键', () => {
    const zhMessage = (zhCN as Record<string, Record<string, string>>).message
    expect(zhMessage).toBeDefined()
    expect(zhMessage.saveError).toBe('保存失败')
  })

  it('en-US 和 zh-CN 的 message 节键集应一致', () => {
    const enKeys = collectLeafKeys(
      (enUS as Record<string, unknown>).message as Record<string, unknown>,
    )
    const zhKeys = collectLeafKeys(
      (zhCN as Record<string, unknown>).message as Record<string, unknown>,
    )
    expect(enKeys).toEqual(zhKeys)
  })
})
