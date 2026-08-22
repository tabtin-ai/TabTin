import { describe, expect, it, vi } from 'vitest'

import {
  createDocument,
  createNamedVersion,
  deleteNamedVersion,
  getDocument,
  getHistoryPreviewMarkdown,
  HistoryPreviewUnavailableError,
  listHistories,
  listDocuments,
  renameVersion,
  restoreHistory,
} from '@tabtin/tabdoc-ui/api-client'

function createMockClient(response: unknown) {
  return {
    request: vi.fn().mockResolvedValue(response),
  } as any
}

describe('tabdoc api-client history endpoints', () => {
  it('listDocuments accepts deprecated spaceId alias', async () => {
    const client = createMockClient({ documents: [] })

    await listDocuments(client, {
      organizationId: 'ws-1',
      spaceId: 'space-1',
    })

    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      endpoint: '/tabdoc/documents',
      params: {
        organization_id: 'ws-1',
        space_id: 'space-1',
      },
    })
  })

  it('createDocument throws early when no space id is provided', async () => {
    const client = createMockClient({})

    await expect(createDocument(client, {
      organizationId: 'ws-1',
      title: 'Untitled',
    })).rejects.toThrow('spaceId is required')

    expect(client.request).not.toHaveBeenCalled()
  })

  it('listHistories uses TabDoc histories endpoint', async () => {
    const client = createMockClient({
      histories: [
        {
          id: 'hist-1',
          document_id: 'doc-1',
          is_snapshot: false,
          editor_type: 'agent',
          editor_id: 'agent-1',
          expired_at: null,
          created_at: '2026-03-06T10:00:00Z',
          is_named: true,
          name: '发布前',
          pinned: true,
        },
      ],
    })

    const histories = await listHistories(client, 'doc-1', 20)

    expect(client.request).toHaveBeenCalledWith({
      method: 'GET',
      endpoint: '/tabdoc/documents/doc-1/histories',
      params: { limit: 20 },
    })
    expect(histories).toEqual([
      {
        id: 'hist-1',
        document_id: 'doc-1',
        is_snapshot: false,
        editor_type: 'agent',
        editor_id: 'agent-1',
        expired_at: null,
        created_at: '2026-03-06T10:00:00Z',
        is_named: true,
        name: '发布前',
        pinned: true,
      },
    ])
  })

  it('restoreHistory uses TabDoc restore-history endpoint', async () => {
    const client = createMockClient({
      document: { id: 'doc-1', latest_version: 4 },
      content: { description_json: {}, description_markdown: '# restored', description_plaintext: 'restored' },
    })

    await restoreHistory(client, 'doc-1', 'hist-1')

    expect(client.request).toHaveBeenCalledWith({
      method: 'POST',
      endpoint: '/tabdoc/documents/doc-1/restore-history',
      body: { history_id: 'hist-1' },
    })
  })

  it('getDocument does not fall back to legacy revision when markdown content exists', async () => {
    const client = createMockClient({
      document: { id: 'doc-1', latest_version: 4 },
      content: {
        description_json: {},
        description_markdown: '# 已恢复内容',
        description_plaintext: '已恢复内容',
      },
      latest_revision: {
        id: 'rev-1',
        version: 1,
        content_pm_json: { type: 'doc', content: [{ type: 'paragraph' }] },
        content_markdown: '# 旧 revision',
        content_plaintext: '旧 revision',
      },
    })

    const detail = await getDocument(client, 'doc-1')

    expect(detail.content.description_markdown).toBe('# 已恢复内容')
    expect(detail.content.description_plaintext).toBe('已恢复内容')
  })

  it('getDocument treats empty shell content as intentionally empty when current version is not behind latest revision', async () => {
    const client = createMockClient({
      document: { id: 'doc-1', latest_version: 1 },
      content: {
        description_json: { type: 'doc', content: [] },
        description_markdown: '<p></p>',
        description_plaintext: '',
      },
      latest_revision: {
        id: 'rev-1',
        version: 1,
        content_pm_json: { type: 'doc', content: [{ type: 'paragraph' }] },
        content_markdown: '# 旧 revision',
        content_plaintext: '旧 revision',
      },
    })

    const detail = await getDocument(client, 'doc-1')

    expect(detail.content.description_markdown).toBe('<p></p>')
    expect(detail.content.description_plaintext).toBe('')
  })

  it('getDocument treats empty content as intentionally empty when version is ahead of revision', async () => {
    const client = createMockClient({
      document: { id: 'doc-1', latest_version: 5 },
      content: {
        description_json: { type: 'doc', content: [] },
        description_markdown: '<p></p>',
        description_plaintext: '',
      },
      latest_revision: {
        id: 'rev-1',
        version: 1,
        content_pm_json: { type: 'doc', content: [{ type: 'paragraph' }] },
        content_markdown: '# 旧 revision',
        content_plaintext: '旧 revision',
      },
    })

    const detail = await getDocument(client, 'doc-1')

    expect(detail.content.description_markdown).toBe('<p></p>')
    expect(detail.content.description_plaintext).toBe('')
  })

  it('createNamedVersion uses TabDoc versions endpoint', async () => {
    const client = createMockClient({
      version: {
        id: 'hist-2',
        document_id: 'doc-1',
        is_snapshot: true,
        editor_type: 'user',
        editor_id: 'user-1',
        expired_at: null,
        created_at: '2026-03-06T11:00:00Z',
        is_named: true,
        name: '里程碑',
        pinned: false,
      },
    })

    const version = await createNamedVersion(client, 'doc-1', '里程碑', {
      baseVersion: 7,
      baseUpdatedAt: '2026-03-07T12:34:56Z',
    })

    expect(client.request).toHaveBeenCalledWith({
      method: 'POST',
      endpoint: '/tabdoc/documents/doc-1/versions',
      body: {
        name: '里程碑',
        base_version: 7,
        base_updated_at: '2026-03-07T12:34:56Z',
      },
    })
    expect(version.id).toBe('hist-2')
    expect(version.name).toBe('里程碑')
    expect(version.is_named).toBe(true)
  })

  it('renameVersion and deleteNamedVersion stay on TabDoc version endpoints', async () => {
    const client = createMockClient({
      version: {
        id: 'hist-3',
        document_id: 'doc-1',
        is_snapshot: true,
        editor_type: 'user',
        editor_id: 'user-1',
        expired_at: null,
        created_at: '2026-03-06T12:00:00Z',
        is_named: true,
        name: '新名称',
        pinned: false,
      },
    })

    const renamed = await renameVersion(client, 'doc-1', 'hist-3', '新名称')
    expect(renamed.name).toBe('新名称')
    expect(client.request).toHaveBeenNthCalledWith(1, {
      method: 'PATCH',
      endpoint: '/tabdoc/documents/doc-1/versions/hist-3',
      body: { name: '新名称' },
    })

    client.request.mockResolvedValueOnce({ deleted: true })
    await deleteNamedVersion(client, 'doc-1', 'hist-3')
    expect(client.request).toHaveBeenNthCalledWith(2, {
      method: 'DELETE',
      endpoint: '/tabdoc/documents/doc-1/versions/hist-3',
    })
  })

  it('getHistoryPreviewMarkdown turns 503 UPSTREAM_UNAVAILABLE into a business error with hint', async () => {
    const cause = Object.assign(new Error('collab-live down'), {
      status: 503,
      code: 'UPSTREAM_UNAVAILABLE',
      data: {
        hint: '稍后重试；或在 Web 端打开该历史版本',
        document_id: 'doc-1',
        history_id: 'hist-1',
      },
    })
    const client = {
      request: vi.fn().mockRejectedValue(cause),
    } as any

    await expect(getHistoryPreviewMarkdown(client, 'doc-1', 'hist-1')).rejects.toMatchObject({
      name: 'HistoryPreviewUnavailableError',
      hint: '稍后重试；或在 Web 端打开该历史版本',
      documentId: 'doc-1',
      historyId: 'hist-1',
    })

    await expect(getHistoryPreviewMarkdown(client, 'doc-1', 'hist-1')).rejects.toBeInstanceOf(HistoryPreviewUnavailableError)
  })

  it('getHistoryPreviewMarkdown keeps empty markdown as real empty preview content', async () => {
    const client = createMockClient({ markdown: '' })

    await expect(getHistoryPreviewMarkdown(client, 'doc-1', 'hist-empty')).resolves.toBe('')
  })

  it('getHistoryPreviewMarkdown rethrows 404 and network errors without remapping', async () => {
    const notFound = Object.assign(new Error('not found'), { status: 404 })
    const networkError = new TypeError('Failed to fetch')

    await expect(getHistoryPreviewMarkdown({
      request: vi.fn().mockRejectedValue(notFound),
    } as any, 'doc-1', 'missing')).rejects.toBe(notFound)

    await expect(getHistoryPreviewMarkdown({
      request: vi.fn().mockRejectedValue(networkError),
    } as any, 'doc-1', 'hist-1')).rejects.toBe(networkError)
  })
})
