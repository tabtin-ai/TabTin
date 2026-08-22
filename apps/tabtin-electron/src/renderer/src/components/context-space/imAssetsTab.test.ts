import { describe, expect, it } from 'vitest'
import { buildResourceTabKey, parseTabKey } from '@stores/contextTabs/helpers'
import {
  IM_ASSETS_TAB_TYPE,
  buildImAssetsId,
  parseImAssetsId,
} from './imAssetsTab'

describe('imAssetsTab id 编码', () => {
  it('buildImAssetsId 生成 `${kind}:${conversationId}`', () => {
    expect(buildImAssetsId('document', 'conv-1')).toBe('document:conv-1')
    expect(buildImAssetsId('file', 'conv-1')).toBe('file:conv-1')
  })

  it('parseImAssetsId 还原 kind + conversationId', () => {
    expect(parseImAssetsId('document:conv-1')).toEqual({ kind: 'document', conversationId: 'conv-1' })
    expect(parseImAssetsId('file:7a3f1ff9-12df-4f86-9270-57ac20222bca')).toEqual({
      kind: 'file',
      conversationId: '7a3f1ff9-12df-4f86-9270-57ac20222bca',
    })
  })

  it('parseImAssetsId 对非法输入返回 null', () => {
    expect(parseImAssetsId('conv-1')).toBeNull()
    expect(parseImAssetsId('bogus:conv-1')).toBeNull()
    expect(parseImAssetsId('document:')).toBeNull()
  })

  it('tabKey 经 buildResourceTabKey / parseTabKey 往返（首冒号切，id 保留后半段）', () => {
    const convId = '7a3f1ff9-12df-4f86-9270-57ac20222bca'
    const id = buildImAssetsId('document', convId)
    const tabKey = buildResourceTabKey(IM_ASSETS_TAB_TYPE, id)
    expect(tabKey).toBe(`imassets:document:${convId}`)

    const parsed = parseTabKey(tabKey)
    expect(parsed).toEqual({ type: 'imassets', id: `document:${convId}` })
    expect(parseImAssetsId(parsed!.id)).toEqual({ kind: 'document', conversationId: convId })
  })
})
