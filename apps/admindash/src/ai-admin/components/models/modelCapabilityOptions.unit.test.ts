import { describe, expect, it } from 'vitest'
import { hasJsonMode, toggleJsonMode } from './modelCapabilityOptions'

describe('模型结构化输出选项', () => {
  it('启用选项时按页面顺序生成后端 CSV 值', () => {
    expect(toggleJsonMode('json_schema', 'json_object', true)).toBe('json_object,json_schema')
  })

  it('关闭选项时保留未被页面识别的扩展值', () => {
    expect(toggleJsonMode('json_object,vendor_extension', 'json_object', false)).toBe(
      'vendor_extension'
    )
  })

  it('识别带空格的既有 CSV 配置', () => {
    expect(hasJsonMode('json_object, json_schema', 'json_schema')).toBe(true)
  })
})
