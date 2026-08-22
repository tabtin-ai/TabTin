import { describe, it, expect, beforeEach } from 'vitest'

/**
 * EC-01 修复验证：tabwhiteboard 节点已注册至 serverSchema
 */
describe('serverSchema — tabwhiteboard 节点', () => {
  // 每个测试重置缓存以确保隔离
  beforeEach(async () => {
    // 动态导入以避免缓存问题
    const mod = await import('../schema/serverSchema.js')
    // 使用新的 schema 实例
    void mod.getDocServerSchema
  })

  it('schema 应包含 tabwhiteboard 节点类型', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    expect(schema.nodes.tabwhiteboard).toBeDefined()
  })

  it('tabwhiteboard 节点应为 block 组', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const spec = schema.nodes.tabwhiteboard.spec
    expect(spec.group).toBe('block')
  })

  it('tabwhiteboard 节点应为 atom', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const spec = schema.nodes.tabwhiteboard.spec
    expect(spec.atom).toBe(true)
  })

  it('tabwhiteboard 节点应包含 canvasId 和 title 属性', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const node = schema.nodes.tabwhiteboard.create({
      canvasId: 'test-canvas-123',
      title: '测试白板',
    })
    expect(node.attrs.canvasId).toBe('test-canvas-123')
    expect(node.attrs.title).toBe('测试白板')
  })

  it('tabwhiteboard 节点默认属性应与客户端 canvas-block 一致', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const node = schema.nodes.tabwhiteboard.create()
    expect(node.attrs.canvasId).toBe('')
    expect(node.attrs.title).toBe('未命名白板')
  })

  it('tabwhiteboard 节点可嵌入 doc 文档结构', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const canvasNode = schema.nodes.tabwhiteboard.create({
      canvasId: 'canvas-001',
      title: '我的白板',
    })
    const doc = schema.nodes.doc.create(null, [canvasNode])
    expect(doc.content.childCount).toBe(1)
    expect(doc.content.firstChild!.type.name).toBe('tabwhiteboard')
  })
})
