import { describe, expect, it } from 'vitest'

import type { ResourceWsEvent } from '@/stores/useUnifiedResources'
import { buildTabDocDocumentPatchFromResourceEvent } from '../tabdocResourceEventPatch'

function makeEvent(overrides: Partial<ResourceWsEvent>): ResourceWsEvent {
  return {
    type: 'resource_updated',
    resource_type: 'tabdoc',
    resource_id: 'doc-1',
    title: '《新标题》',
    space_id: 'space-1',
    ...overrides,
  }
}

describe('tabdoc resource event patch', () => {
  it('把 resource_updated 的标题转成当前文档 patch', () => {
    expect(buildTabDocDocumentPatchFromResourceEvent(makeEvent({ title: '《新标题》' }))).toEqual({
      title: '《新标题》',
    })
  })

  it('同步 TabDoc 资源 metadata 中的文档字段', () => {
    expect(buildTabDocDocumentPatchFromResourceEvent(makeEvent({
      title: '标题',
      status: 'active',
      updated_at: '2026-06-08T07:00:00Z',
      metadata: {
        parent_id: null,
        latest_version: 7,
        icon: '📄',
        cover_image: 'https://example.test/cover.png',
        tags: ['agent', 'doc'],
      },
    }))).toEqual({
      title: '标题',
      status: 'active',
      updated_at: '2026-06-08T07:00:00Z',
      parent_id: null,
      icon: '📄',
      cover_image: 'https://example.test/cover.png',
      tags: ['agent', 'doc'],
    })
  })

  it('不让未签名的本地对象 URL 覆盖当前封面的签名 URL', () => {
    expect(buildTabDocDocumentPatchFromResourceEvent(
      makeEvent({
        updated_at: '2026-08-20T07:01:33Z',
        metadata: {
          cover_image: 'http://192.168.31.219:6060/api/services/oss/local-object?object_key=tabdoc%2Fcovers%2Fcover.png',
        },
      }),
      {
        updated_at: '2026-08-20T07:01:29Z',
        cover_image: 'http://192.168.31.219:6060/api/services/oss/local-object?object_key=tabdoc%2Fcovers%2Fcover.png&method=GET&expires=3600&signature=signed',
      },
    )).toEqual({
      title: '《新标题》',
      updated_at: '2026-08-20T07:01:33Z',
    })
  })

  it('忽略旧事件整包，避免迟到资源回声回滚标题、metadata 与 CAS 基线', () => {
    expect(buildTabDocDocumentPatchFromResourceEvent(
      makeEvent({
        title: '旧标题',
        updated_at: '2026-06-08T07:00:00Z',
        metadata: {
          icon: 'old-icon',
        },
      }),
      { updated_at: '2026-06-08T07:01:00Z' },
    )).toBeNull()
  })

  it('忽略非更新事件和类型不匹配的 metadata', () => {
    expect(buildTabDocDocumentPatchFromResourceEvent(makeEvent({
      type: 'resource_created',
    }))).toBeNull()

    expect(buildTabDocDocumentPatchFromResourceEvent(makeEvent({
      title: undefined,
      metadata: {
        latest_version: '7',
        tags: ['ok', 1],
      },
    }))).toBeNull()
  })
})
