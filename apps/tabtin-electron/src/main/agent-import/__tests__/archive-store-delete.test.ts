import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = path.join(os.tmpdir(), `tabtin-archive-test-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpRoot,
  },
}))

import {
  bindOpenedSession,
  deleteArchives,
  findArchiveByOpenedSessionId,
  writeArchive,
  readArchive,
  readIndex,
  trySafeOrganizationId,
  trySafeImportSource,
} from '../archive-store'

const orgId = 'org-test'

function seed(meta: {
  sourceSessionId: string
  workspaceId: string | null
  cwd: string | null
}) {
  writeArchive({
    meta: {
      source: 'cursor',
      sourceSessionId: meta.sourceSessionId,
      title: meta.sourceSessionId,
      cwd: meta.cwd,
      workspaceId: meta.workspaceId,
      workspaceName: 'ws',
      deviceId: 'dev-1',
      organizationId: orgId,
      importedAt: new Date().toISOString(),
      layer: 'full',
      messageCount: 0,
      archived: false,
      kind: 'external_archive',
    },
    messages: [],
  })
}

describe('deleteArchives workspace / cwd', () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.mkdirSync(tmpRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('deletes a single archive by source + sourceSessionId', () => {
    seed({
      sourceSessionId: 'keep-me',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    seed({
      sourceSessionId: 'delete-me',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })

    const { deleted } = deleteArchives({
      organizationId: orgId,
      source: 'cursor',
      sourceSessionIds: ['delete-me'],
    })

    expect(deleted).toBe(1)
    expect(readIndex(orgId).map((e) => e.sourceSessionId)).toEqual(['keep-me'])
    expect(readArchive(orgId, 'cursor', 'delete-me')).toBeNull()
  })

  it('deletes by workspaceId or same cwd (OR), catching stale workspaceId', () => {
    seed({
      sourceSessionId: 'old-ws-session',
      workspaceId: 'ws-old',
      cwd: '/Users/me/proj',
    })
    seed({
      sourceSessionId: 'new-ws-session',
      workspaceId: 'ws-new',
      cwd: '/Users/me/proj',
    })
    seed({
      sourceSessionId: 'other-dir',
      workspaceId: 'ws-other',
      cwd: '/Users/me/other',
    })

    const { deleted } = deleteArchives({
      organizationId: orgId,
      workspaceId: 'ws-new',
      cwd: '/Users/me/proj/',
    })

    expect(deleted).toBe(2)
    const left = readIndex(orgId)
    expect(left.map((e) => e.sourceSessionId)).toEqual(['other-dir'])
  })

  it('bindOpenedSession 写入 meta 与 index，供再次打开复用', () => {
    seed({
      sourceSessionId: 'sess-a',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    expect(
      bindOpenedSession({
        organizationId: orgId,
        source: 'cursor',
        sourceSessionId: 'sess-a',
        sessionId: 'chat-session-1',
      }),
    ).toBe(true)
    expect(readArchive(orgId, 'cursor', 'sess-a')?.meta.openedSessionId).toBe('chat-session-1')
    expect(readIndex(orgId).find((e) => e.sourceSessionId === 'sess-a')?.openedSessionId).toBe(
      'chat-session-1',
    )
    expect(findArchiveByOpenedSessionId(orgId, 'chat-session-1')?.meta.sourceSessionId).toBe('sess-a')
    expect(findArchiveByOpenedSessionId(orgId, 'missing')).toBeNull()
  })
})

describe('archive-store organization / workspace scope', () => {
  beforeEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
    fs.mkdirSync(tmpRoot, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('合法 organizationId 可读到本 org 档案', () => {
    seed({
      sourceSessionId: 'in-scope',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    expect(readIndex(orgId).map((e) => e.sourceSessionId)).toEqual(['in-scope'])
    expect(readArchive(orgId, 'cursor', 'in-scope')?.meta.sourceSessionId).toBe('in-scope')
  })

  it('空 organizationId：index 空、archive null、bind 失败（IPC 同口径）', () => {
    seed({
      sourceSessionId: 'in-scope',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    expect(readIndex('')).toEqual([])
    expect(readArchive('', 'cursor', 'in-scope')).toBeNull()
    expect(
      bindOpenedSession({
        organizationId: '',
        source: 'cursor',
        sourceSessionId: 'in-scope',
        sessionId: 'chat-1',
      }),
    ).toBe(false)
  })

  it('跨 organization：org-A 有档时 org-B 读不到（路径隔离，非服务端鉴权）', () => {
    seed({
      sourceSessionId: 'org-a-only',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    expect(readIndex('org-other')).toEqual([])
    expect(readArchive('org-other', 'cursor', 'org-a-only')).toBeNull()
    expect(
      bindOpenedSession({
        organizationId: 'org-other',
        source: 'cursor',
        sourceSessionId: 'org-a-only',
        sessionId: 'chat-x',
      }),
    ).toBe(false)
  })

  it('bindOpenedSession 对不存在的档案返回 false', () => {
    expect(
      bindOpenedSession({
        organizationId: orgId,
        source: 'cursor',
        sourceSessionId: 'missing',
        sessionId: 'chat-1',
      }),
    ).toBe(false)
  })

  it('bindOpenedSession 空 sessionId 返回 false', () => {
    seed({
      sourceSessionId: 'sess-b',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    expect(
      bindOpenedSession({
        organizationId: orgId,
        source: 'cursor',
        sourceSessionId: 'sess-b',
        sessionId: '',
      }),
    ).toBe(false)
  })

  it('拒绝 organizationId 路径穿越（审阅复现 ../external-archives/org-a）', () => {
    seed({
      sourceSessionId: 'org-a-only',
      workspaceId: 'ws-1',
      cwd: '/Users/me/proj',
    })
    const traversal = '../external-archives/org-test'
    expect(trySafeOrganizationId(traversal)).toBeNull()
    expect(readIndex(traversal)).toEqual([])
    expect(readArchive(traversal, 'cursor', 'org-a-only')).toBeNull()
    expect(
      bindOpenedSession({
        organizationId: traversal,
        source: 'cursor',
        sourceSessionId: 'org-a-only',
        sessionId: 'chat-x',
      }),
    ).toBe(false)
    // 合法 org 仍可读
    expect(readIndex(orgId).map((e) => e.sourceSessionId)).toEqual(['org-a-only'])
  })

  it('拒绝非法 source 枚举与带分隔符的 source', () => {
    expect(trySafeImportSource('not-a-source')).toBeNull()
    expect(trySafeImportSource('../codex')).toBeNull()
    expect(trySafeImportSource('codex')).toBe('codex')
    expect(readArchive(orgId, '../codex', 'x')).toBeNull()
  })
})

