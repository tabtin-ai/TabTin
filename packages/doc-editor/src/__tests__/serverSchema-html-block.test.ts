import { describe, it, expect } from 'vitest'

/**
 *  — htmlBlock 节点已注册至 serverSchema。
 *
 * serverSchema 是 collab-live / yjsConverters 的权威 schema，若 htmlBlock 未注册，
 * 协作加载（Y.js → PM JSON）时 degradeUnknownNodes 会把它降级为 paragraph 导致节点丢失
 * （历史坑 TD-13 / ）。
 */
describe('serverSchema — htmlBlock 节点', () => {
  it('schema 应包含 htmlBlock 节点类型', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    expect(schema.nodes.htmlBlock).toBeDefined()
  })

  it('htmlBlock 节点应为 block 组且为 atom', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const spec = schema.nodes.htmlBlock.spec
    expect(spec.group).toBe('block')
    expect(spec.atom).toBe(true)
  })

  it('htmlBlock 节点应包含 fileId / src / title / height 属性', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const node = schema.nodes.htmlBlock.create({
      fileId: 'file_123',
      src: 'https://cdn.example.com/a.html',
      title: '架构图',
      height: 600,
    })
    expect(node.attrs.fileId).toBe('file_123')
    expect(node.attrs.src).toBe('https://cdn.example.com/a.html')
    expect(node.attrs.title).toBe('架构图')
    expect(node.attrs.height).toBe(600)
  })

  it('htmlBlock 默认属性应与客户端 html-block 一致', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const node = schema.nodes.htmlBlock.create()
    expect(node.attrs.blockId ?? null).toBeNull()
    expect(node.attrs.fileId).toBe('')
    expect(node.attrs.src).toBe('')
    expect(node.attrs.title).toBe('未命名 HTML')
    expect(node.attrs.height).toBe(480)
  })

  it('htmlBlock 节点可嵌入 doc 文档结构', async () => {
    const { getDocServerSchema } = await import('../schema/serverSchema.js')
    const schema = getDocServerSchema()
    const htmlNode = schema.nodes.htmlBlock.create({
      fileId: 'file_1',
      src: 'https://cdn.example.com/x.html',
      title: '我的 HTML',
    })
    const doc = schema.nodes.doc.create(null, [htmlNode])
    expect(doc.content.childCount).toBe(1)
    expect(doc.content.firstChild!.type.name).toBe('htmlBlock')
  })
})
