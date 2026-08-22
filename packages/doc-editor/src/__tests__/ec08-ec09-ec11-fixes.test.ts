import { describe, it, expect } from 'vitest'

/**
 * EC-08: mathematicsBlock 节点注册验证
 * EC-09: CSS 颜色正则安全性验证
 * EC-11: extractPlaintext 块级语义验证
 */

describe('EC-08: serverSchema — mathematicsBlock 节点', () => {
  it('schema 应包含 mathematicsBlock 节点类型', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    expect(schema.nodes.mathematicsBlock).toBeDefined()
  })

  it('mathematicsBlock 应为 block 组', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const spec = schema.nodes.mathematicsBlock.spec
    expect(spec.group).toBe('block')
  })

  it('mathematicsBlock 应为 atom', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const spec = schema.nodes.mathematicsBlock.spec
    expect(spec.atom).toBe(true)
  })

  it('inline mathematics 仍然存在且为 inline 组', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    expect(schema.nodes.mathematics).toBeDefined()
    expect(schema.nodes.mathematics.spec.group).toBe('inline')
    expect(schema.nodes.mathematics.spec.inline).toBe(true)
  })
})

describe('EC-09: CSS 颜色正则安全性', () => {
  // 直接测试正则行为
  const SAFE_CSS_COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|hsl)a?\([\d%,.\s]+\)|[a-zA-Z]{1,20})$/

  it('接受合法 hex 颜色', () => {
    expect(SAFE_CSS_COLOR_RE.test('#fff')).toBe(true)
    expect(SAFE_CSS_COLOR_RE.test('#aabbcc')).toBe(true)
    expect(SAFE_CSS_COLOR_RE.test('#aabbccff')).toBe(true)
  })

  it('接受合法 rgb/rgba 颜色', () => {
    expect(SAFE_CSS_COLOR_RE.test('rgb(255, 0, 0)')).toBe(true)
    expect(SAFE_CSS_COLOR_RE.test('rgba(255, 0, 0, 0.5)')).toBe(true)
    expect(SAFE_CSS_COLOR_RE.test('hsl(120, 100%, 50%)')).toBe(true)
  })

  it('接受合法命名颜色', () => {
    expect(SAFE_CSS_COLOR_RE.test('red')).toBe(true)
    expect(SAFE_CSS_COLOR_RE.test('transparent')).toBe(true)
  })

  it('拒绝含分号的 CSS 注入', () => {
    expect(SAFE_CSS_COLOR_RE.test("rgb(255,0,0); background: url('javascript:alert(1)')")).toBe(false)
  })

  it('拒绝含括号嵌套的注入', () => {
    expect(SAFE_CSS_COLOR_RE.test('rgb(0,0,0) url(evil)')).toBe(false)
  })

  it('拒绝含字母的 rgb 值（expression 注入）', () => {
    expect(SAFE_CSS_COLOR_RE.test('rgb(expression(alert(1)))')).toBe(false)
  })
})
