import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppHostClient } from '@tabtin/app-host-sdk'
import {
  flushEditorContentBeforeExport,
  isTabDocVersionConflictError,
} from '../editor/flushEditorContentBeforeExport'
import * as apiClient from '../api-client'

vi.mock('../api-client', async () => {
  const actual = await vi.importActual<typeof import('../api-client')>('../api-client')
  return {
    ...actual,
    getDocument: vi.fn(),
    saveContent: vi.fn(),
  }
})

const getDocument = vi.mocked(apiClient.getDocument)
const saveContent = vi.mocked(apiClient.saveContent)

function makeDoc(version: number, updatedAt = `t${version}`) {
  return {
    id: 'doc-1',
    organization_id: 'org-1',
    space_id: 'space-1',
    parent_id: null,
    title: 'Demo',
    status: 'active' as const,
    latest_version: version,
    icon: '',
    cover_image: '',
    cover_position: 0.5,
    tags: [],
    properties: {},
    is_full_width: false,
    font_style: 'default' as const,
    created_by: null,
    updated_by: null,
    created_at: null,
    updated_at: updatedAt,
  }
}

describe('isTabDocVersionConflictError', () => {
  it('detects 409 / VERSION_CONFLICT / message text', () => {
    expect(isTabDocVersionConflictError({ status: 409 })).toBe(true)
    expect(isTabDocVersionConflictError({ code: 'VERSION_CONFLICT' })).toBe(true)
    expect(isTabDocVersionConflictError(new Error('版本冲突：当前版本 14，提交版本 10'))).toBe(true)
    expect(isTabDocVersionConflictError(new Error('network down'))).toBe(false)
  })
})

describe('flushEditorContentBeforeExport', () => {
  const client = {} as AppHostClient
  const snapshot = {
    pmJson: { type: 'doc', content: [] },
    markdown: 'hello',
    plaintext: 'hello',
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips when cannot edit or editor snapshot missing', async () => {
    await flushEditorContentBeforeExport({
      client,
      documentId: 'doc-1',
      canEdit: false,
      getEditorSnapshot: () => snapshot,
      getSaveBaseline: () => ({ baseVersion: 10, baseUpdatedAt: 't10' }),
      applyBaseline: vi.fn(),
    })
    expect(saveContent).not.toHaveBeenCalled()

    await flushEditorContentBeforeExport({
      client,
      documentId: 'doc-1',
      canEdit: true,
      getEditorSnapshot: () => null,
      getSaveBaseline: () => ({ baseVersion: 10, baseUpdatedAt: 't10' }),
      applyBaseline: vi.fn(),
    })
    expect(saveContent).not.toHaveBeenCalled()
  })

  it('uses live save baseline and applies flushed document', async () => {
    const applyBaseline = vi.fn()
    const flushed = makeDoc(11)
    saveContent.mockResolvedValueOnce({
      document: flushed,
      content: {
        description_json: {},
        description_markdown: 'hello',
        description_plaintext: 'hello',
      },
    })

    await flushEditorContentBeforeExport({
      client,
      documentId: 'doc-1',
      canEdit: true,
      getEditorSnapshot: () => snapshot,
      getSaveBaseline: () => ({ baseVersion: 10, baseUpdatedAt: 't10' }),
      applyBaseline,
    })

    expect(saveContent).toHaveBeenCalledWith(client, 'doc-1', {
      baseVersion: 10,
      baseUpdatedAt: 't10',
      pmJson: snapshot.pmJson,
      markdown: snapshot.markdown,
      plaintext: snapshot.plaintext,
    })
    expect(applyBaseline).toHaveBeenCalledWith(flushed)
  })

  it('refreshes baseline and retries once after version conflict', async () => {
    const applyBaseline = vi.fn()
    const conflict = Object.assign(new Error('版本冲突：当前版本 14，提交版本 10'), {
      status: 409,
      code: 'VERSION_CONFLICT',
    })
    saveContent
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        document: makeDoc(15),
        content: {
          description_json: {},
          description_markdown: 'hello',
          description_plaintext: 'hello',
        },
      })
    getDocument.mockResolvedValueOnce({
      document: makeDoc(14),
      content: {
        description_json: {},
        description_markdown: 'server',
        description_plaintext: 'server',
      },
      latest_revision: null,
    })

    await flushEditorContentBeforeExport({
      client,
      documentId: 'doc-1',
      canEdit: true,
      getEditorSnapshot: () => snapshot,
      getSaveBaseline: () => ({ baseVersion: 10, baseUpdatedAt: 't10' }),
      applyBaseline,
    })

    expect(getDocument).toHaveBeenCalledWith(client, 'doc-1')
    expect(applyBaseline).toHaveBeenNthCalledWith(1, {
      latest_version: 14,
      updated_at: 't14',
    })
    expect(saveContent).toHaveBeenNthCalledWith(2, client, 'doc-1', expect.objectContaining({
      baseVersion: 14,
      // 重试刻意不带 updated_at，避免同版本伪冲突
      baseUpdatedAt: null,
    }))
    expect(applyBaseline).toHaveBeenLastCalledWith(makeDoc(15))
  })

  it('retries same-version updated_at pseudo conflict (N vs N)', async () => {
    const applyBaseline = vi.fn()
    const conflict = Object.assign(new Error('版本冲突：当前版本 9，提交版本 9'), {
      status: 409,
      code: 'VERSION_CONFLICT',
    })
    saveContent
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        document: makeDoc(10),
        content: {
          description_json: {},
          description_markdown: 'hello',
          description_plaintext: 'hello',
        },
      })
    getDocument.mockResolvedValueOnce({
      document: makeDoc(9),
      content: {
        description_json: {},
        description_markdown: 'server',
        description_plaintext: 'server',
      },
      latest_revision: null,
    })

    await flushEditorContentBeforeExport({
      client,
      documentId: 'doc-1',
      canEdit: true,
      getEditorSnapshot: () => snapshot,
      getSaveBaseline: () => ({ baseVersion: 9, baseUpdatedAt: 'stale-ts' }),
      applyBaseline,
    })

    expect(saveContent).toHaveBeenNthCalledWith(2, client, 'doc-1', expect.objectContaining({
      baseVersion: 9,
      baseUpdatedAt: null,
    }))
    expect(applyBaseline).toHaveBeenLastCalledWith(makeDoc(10))
  })

  it('rethrows when conflict retries are exhausted', async () => {
    const conflict = Object.assign(new Error('版本冲突：当前版本 14，提交版本 10'), {
      status: 409,
    })
    saveContent.mockRejectedValue(conflict)
    getDocument.mockResolvedValue({
      document: makeDoc(14),
      content: {
        description_json: {},
        description_markdown: 'server',
        description_plaintext: 'server',
      },
      latest_revision: null,
    })

    await expect(flushEditorContentBeforeExport({
      client,
      documentId: 'doc-1',
      canEdit: true,
      getEditorSnapshot: () => snapshot,
      getSaveBaseline: () => ({ baseVersion: 10, baseUpdatedAt: 't10' }),
      applyBaseline: vi.fn(),
      maxConflictRetries: 1,
    })).rejects.toThrow(/版本冲突/)

    expect(saveContent).toHaveBeenCalledTimes(2)
    expect(getDocument).toHaveBeenCalledTimes(1)
  })
})
