import { describe, expect, it, vi } from 'vitest'

import { createTabDocMetadataSaveQueue } from '../tabdocMetadataSaveQueue'

interface MetadataUpdate {
  title?: string
  icon?: string
}

interface SavedDocument {
  latest_version: number
  updated_at: string
}

describe('createTabDocMetadataSaveQueue', () => {
  it('serializes concurrent metadata saves and reads the latest base version', async () => {
    let baseVersion = 4
    let baseUpdatedAt = 't4'
    const requests: Array<{
      updates: MetadataUpdate
      baseVersion: number | null
      baseUpdatedAt: string | null
    }> = []

    const queue = createTabDocMetadataSaveQueue<MetadataUpdate, SavedDocument>({
      flushContent: vi.fn(async () => undefined),
      getBaseVersion: () => baseVersion,
      getBaseUpdatedAt: () => baseUpdatedAt,
      saveMetadata: vi.fn(async (request) => {
        requests.push(request)
        if (request.updates.title) {
          return { latest_version: 5, updated_at: 't5' }
        }
        return { latest_version: 5, updated_at: 't6' }
      }),
      applyResult: (document) => {
        baseVersion = document.latest_version
        baseUpdatedAt = document.updated_at
      },
    })

    await Promise.all([
      queue.enqueue({ title: 'New title' }),
      queue.enqueue({ icon: 'doc' }),
    ])

    expect(requests).toEqual([
      {
        updates: { title: 'New title' },
        baseVersion: 4,
        baseUpdatedAt: 't4',
      },
      {
        updates: { icon: 'doc' },
        baseVersion: 5,
        baseUpdatedAt: 't5',
      },
    ])
  })

  it('retries once after version conflict refresh', async () => {
    let baseVersion = 1
    const refreshAfterVersionConflict = vi.fn(async () => {
      baseVersion = 2
    })
    const saveMetadata = vi.fn(async (request) => {
      if (request.baseVersion === 1) {
        const error = new Error('版本冲突：当前版本 2，提交版本 1') as Error & {
          status: number
          code: string
        }
        error.status = 409
        error.code = 'VERSION_CONFLICT'
        throw error
      }
      return { latest_version: 2, updated_at: 't2' }
    })

    const queue = createTabDocMetadataSaveQueue<MetadataUpdate, SavedDocument>({
      flushContent: vi.fn(async () => undefined),
      refreshAfterVersionConflict,
      getBaseVersion: () => baseVersion,
      getBaseUpdatedAt: () => 't1',
      saveMetadata,
      applyResult: vi.fn(),
    })

    await expect(queue.enqueue({ title: 'New title' })).resolves.toEqual({
      latest_version: 2,
      updated_at: 't2',
    })
    expect(refreshAfterVersionConflict).toHaveBeenCalledTimes(1)
    expect(saveMetadata).toHaveBeenCalledTimes(2)
    expect(saveMetadata.mock.calls[1]?.[0]).toEqual({
      updates: { title: 'New title' },
      baseVersion: 2,
      baseUpdatedAt: 't1',
    })
  })

  it('retries equal-version conflict detected from message only', async () => {
    let baseUpdatedAt = 't3-stale'
    const refreshAfterVersionConflict = vi.fn(async () => {
      baseUpdatedAt = 't3-fresh'
    })
    const saveMetadata = vi.fn(async (request) => {
      if (request.baseUpdatedAt === 't3-stale') {
        // 诊断包实测：协作正文落库只推了 latest_version，未推 updated_at
        throw new Error('版本冲突：当前版本 3，提交版本 3')
      }
      return { latest_version: 3, updated_at: 't3-fresh' }
    })

    const queue = createTabDocMetadataSaveQueue<MetadataUpdate, SavedDocument>({
      flushContent: vi.fn(async () => undefined),
      refreshAfterVersionConflict,
      getBaseVersion: () => 3,
      getBaseUpdatedAt: () => baseUpdatedAt,
      saveMetadata,
      applyResult: vi.fn(),
    })

    await expect(queue.enqueue({ title: 'Final title' })).resolves.toEqual({
      latest_version: 3,
      updated_at: 't3-fresh',
    })
    expect(refreshAfterVersionConflict).toHaveBeenCalledTimes(1)
    expect(saveMetadata).toHaveBeenCalledTimes(2)
  })

  it('retries version conflict up to maxConflictRetries times', async () => {
    let baseVersion = 1
    const refreshAfterVersionConflict = vi.fn(async () => {
      baseVersion += 1
    })
    const saveMetadata = vi.fn(async () => {
      const error = new Error(`版本冲突：当前版本 ${baseVersion + 1}，提交版本 ${baseVersion}`) as Error & {
        status: number
      }
      error.status = 409
      throw error
    })

    const queue = createTabDocMetadataSaveQueue<MetadataUpdate, SavedDocument>({
      flushContent: vi.fn(async () => undefined),
      refreshAfterVersionConflict,
      getBaseVersion: () => baseVersion,
      getBaseUpdatedAt: () => 't1',
      saveMetadata,
      applyResult: vi.fn(),
      maxConflictRetries: 2,
    })

    await expect(queue.enqueue({ title: 'Busy title' })).rejects.toThrow(/版本冲突/)
    expect(refreshAfterVersionConflict).toHaveBeenCalledTimes(2)
    expect(saveMetadata).toHaveBeenCalledTimes(3)
  })

  it('continues processing queued saves after a failed save', async () => {
    let attempts = 0
    const saveMetadata = vi.fn(async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('network down')
      }
      return { latest_version: 6, updated_at: 't6' }
    })

    const queue = createTabDocMetadataSaveQueue<MetadataUpdate, SavedDocument>({
      flushContent: vi.fn(async () => undefined),
      getBaseVersion: () => 5,
      getBaseUpdatedAt: () => 't5',
      saveMetadata,
      applyResult: vi.fn(),
    })

    const first = queue.enqueue({ title: 'stale title' })
    const second = queue.enqueue({ icon: 'ok' })

    await expect(first).rejects.toThrow('network down')
    await expect(second).resolves.toEqual({ latest_version: 6, updated_at: 't6' })
    expect(saveMetadata).toHaveBeenCalledTimes(2)
  })

  it('resumes content autosave when metadata save fails', async () => {
    const suspendContent = vi.fn()
    const resumeContent = vi.fn()
    const queue = createTabDocMetadataSaveQueue<MetadataUpdate, SavedDocument>({
      suspendContent,
      resumeContent,
      flushContent: vi.fn(async () => undefined),
      getBaseVersion: () => 5,
      getBaseUpdatedAt: () => 't5',
      saveMetadata: vi.fn(async () => {
        throw new Error('network down')
      }),
      applyResult: vi.fn(),
    })

    await expect(queue.enqueue({ title: 'offline title' })).rejects.toThrow('network down')
    expect(suspendContent).toHaveBeenCalledTimes(1)
    expect(resumeContent).toHaveBeenCalledTimes(1)
  })
})
