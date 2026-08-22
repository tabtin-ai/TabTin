/**
 * stripVisualTabMeta 契约锁定。
 *
 * 背景：`list_context_space` 工具返回的 tab.meta 会进入 Agent 上下文。favicon /
 * themeColor 是纯视觉字段——favicon 常是 base64 data URI，会把图标暴露给 Agent
 * 并膨胀 token。本函数在 Agent 消费点剥离这两个字段，同时保留其余全部语义字段。
 */
import { describe, expect, it } from 'vitest'
import { stripVisualTabMeta } from './ContextSpaceToolHandler'

describe('stripVisualTabMeta', () => {
  it('剥离浏览器 tab 的 favicon 与 themeColor', () => {
    const tab = {
      type: 'tabweb',
      id: 'view-1',
      title: 'Example',
      meta: {
        url: 'https://example.com',
        favicon: 'data:image/png;base64,AAAA',
        themeColor: '#ff0000',
        crawlspaceId: 'cs-1',
        isPreview: false,
      },
    }
    const result = stripVisualTabMeta(tab)
    expect(result.meta).toEqual({
      url: 'https://example.com',
      crawlspaceId: 'cs-1',
      isPreview: false,
    })
    expect(result.meta).not.toHaveProperty('favicon')
    expect(result.meta).not.toHaveProperty('themeColor')
  })

  it('保留非视觉语义字段（terminal / table / mail 等 handler 自定义 meta）', () => {
    const tab = {
      type: 'terminal',
      id: 't-1',
      meta: { source: 'agent', status: 'running', cwd: '/home/x', createdAt: 123 },
    }
    const result = stripVisualTabMeta(tab)
    expect(result.meta).toEqual({ source: 'agent', status: 'running', cwd: '/home/x', createdAt: 123 })
  })

  it('无视觉字段时返回原对象引用（零拷贝）', () => {
    const tab = { type: 'table', id: 'tbl-1', meta: { current_view_id: 'v-1' } }
    expect(stripVisualTabMeta(tab)).toBe(tab)
  })

  it('meta 缺失时原样返回', () => {
    const tab = { type: 'apphome', id: 'home' }
    expect(stripVisualTabMeta(tab)).toBe(tab)
  })
})
