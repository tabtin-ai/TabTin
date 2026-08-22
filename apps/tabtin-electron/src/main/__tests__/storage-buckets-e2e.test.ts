/**
 * W2.2-G2 北极星验收测试：listBuckets({ group: 'conversation' }) ≥ 11
 * + listBuckets({ group: 'checkpoint' }) ≥ 1
 *
 * R1/R3 修复版：直接调用真实的 `registerAgentStorageBuckets`、
 * `getEventPersistence` 与 `registerCheckpointStorageBucket` —— 全部走
 * 生产代码路径，不再用手抄 stub。
 *
 * 这一测试是 W2.2 Wave 2 G2 的"业务级 + 命令验证"北极星。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let tempUserData: string
let tempHome: string

beforeEach(() => {
  vi.resetModules()
  tempUserData = mkdtempSync(join(tmpdir(), 'g2-userdata-'))
  tempHome = mkdtempSync(join(tmpdir(), 'g2-home-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  try { rmSync(tempUserData, { recursive: true, force: true }) } catch { /* noop */ }
  try { rmSync(tempHome, { recursive: true, force: true }) } catch { /* noop */ }
})

describe('W2.2-G2 北极星：listBuckets 计数（真实代码路径）', () => {
  it('调用真实 register 后 conversation 组 ≥ 7（main 端）+ checkpoint ≥ 1', async () => {
    // ─── 1. 重置 storage-manager singleton ─────────────────
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()

    // ─── 2. agent:* 7 个 bucket（走 agent-storage-buckets 真实模块） ─
    const dataRoot = join(tempUserData, 'data-root')
    const syncRoot = join(tempUserData, 'agent-sync')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(syncRoot, { recursive: true })
    const { registerAgentStorageBuckets, __resetAgentBucketsCacheForTesting } =
      await import('../agent/platform/agent-storage-buckets')
    __resetAgentBucketsCacheForTesting()
    registerAgentStorageBuckets({
      dataRoot,
      syncRoot,
      getCurrentOwner: async () => ({ userId: 'u-1', organizationId: 'wt-1' }),
    })

    // ─── 3. agent:run-events（EventPersistence 真实实例） ──
    vi.doMock('electron', () => ({
      app: {
        getPath: (k: string) => {
          if (k === 'userData') return tempUserData
          if (k === 'home') return tempHome
          return tempUserData
        },
      },
    }))
    const ep = await import('../run-session/EventPersistence')
    ep.getEventPersistence()

    // ─── 4. checkpoint:shadow-git ───────────────────────────
    vi.doMock('../logger', () => ({
      createLogger: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }),
    }))
    vi.doMock('../auth', () => ({ isTrustedSender: () => true }))
    vi.doMock('../utils/guarded-handle', () => ({ guardedHandle: vi.fn() }))
    vi.doMock('../download-security', () => ({ isPathSafe: () => true }))
    vi.doMock('../checkpoint/CheckpointService', () => ({
      getCheckpointService: vi.fn(),
      destroyCheckpointService: vi.fn(),
    }))
    const ipc = await import('../checkpoint/checkpoint-ipc')
    ipc.registerCheckpointStorageBucket()

    // ─── 5. 实测 listBuckets ────────────────────────────────
    const allBuckets = sm.listBuckets({ includeHidden: true })
    const conversationBuckets = sm.listBuckets({ group: 'conversation', includeHidden: true })
    const checkpointBuckets = sm.listBuckets({ group: 'checkpoint' })

    // main 端对话注册 7 个；run-events 归到 browser，不混入对话历史。
    expect(
      conversationBuckets.length,
      `main 端 conversation 组应 ≥ 7，实际：${conversationBuckets.map(b => b.id).join(', ')}`,
    ).toBeGreaterThanOrEqual(7)

    expect(
      checkpointBuckets.length,
      `checkpoint 组应 ≥ 1，实际：${checkpointBuckets.map(b => b.id).join(', ')}`,
    ).toBeGreaterThanOrEqual(1)

    const ids = new Set(allBuckets.map(b => b.id))
    const required = [
      'agent:conversations:messages',
      'agent:conversations:snapshots',
      'agent:conversations:events',
      'agent:tool-logs',
      'agent:tool-results',
      'agent:sync-pending',
      'agent:sync-archive',
      'agent:run-events',
      'checkpoint:shadow-git',
    ]
    for (const id of required) {
      expect(ids.has(id), `必需 bucket 缺失：${id}`).toBe(true)
    }

    // 关键 schema 校验：data 类必须有非空 warnings + hard 确认
    const messages = sm.getBucket('agent:conversations:messages')
    expect(messages?.category).toBe('data')
    expect(messages?.requiresConfirmation).toBe('hard')
    expect(Array.isArray(messages?.warnings) && messages!.warnings!.length >= 1).toBe(true)

    const syncPending = sm.getBucket('agent:sync-pending')
    expect(syncPending?.category).toBe('data')
    expect(Array.isArray(syncPending?.warnings) && syncPending!.warnings!.length >= 1).toBe(true)

    const runEvents = sm.getBucket('agent:run-events')
    expect(runEvents?.group).toBe('browser')
    await expect(sm.getBucketSize('agent:run-events')).resolves.toMatchObject({
      bytes: 0,
      itemCount: 0,
    })
    await expect(sm.listBucketItems('agent:run-events')).resolves.toEqual([])

    const cp = sm.getBucket('checkpoint:shadow-git')
    expect(cp?.category).toBe('data')
    expect(Array.isArray(cp?.warnings) && cp!.warnings!.length >= 1).toBe(true)
  })

  it('agent-storage-buckets sizeFn 在空目录时不超时（< 1s）', async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const dataRoot = join(tempUserData, 'data-root')
    const syncRoot = join(tempUserData, 'agent-sync')
    mkdirSync(dataRoot, { recursive: true })
    mkdirSync(syncRoot, { recursive: true })
    const { registerAgentStorageBuckets, __resetAgentBucketsCacheForTesting } =
      await import('../agent/platform/agent-storage-buckets')
    __resetAgentBucketsCacheForTesting()
    registerAgentStorageBuckets({
      dataRoot,
      syncRoot,
      getCurrentOwner: async () => ({ userId: 'u-1', organizationId: 'wt-1' }),
    })

    const t0 = Date.now()
    const sizes = await Promise.all([
      sm.getBucketSize('agent:conversations:messages'),
      sm.getBucketSize('agent:conversations:snapshots'),
      sm.getBucketSize('agent:conversations:events'),
      sm.getBucketSize('agent:tool-logs'),
      sm.getBucketSize('agent:tool-results'),
      sm.getBucketSize('agent:sync-pending'),
      sm.getBucketSize('agent:sync-archive'),
    ])
    const elapsed = Date.now() - t0
    expect(elapsed, `sizeFn 总计应 < 1000ms，实际 ${elapsed}ms`).toBeLessThan(1000)
    for (const s of sizes) {
      expect(s.bytes).toBe(0)
      expect(s.itemCount).toBe(0)
    }
  })

  it('agent:conversations:messages clearFn 按 (userId, organizationId, workspaceId) 精准过滤', async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const dataRoot = join(tempUserData, 'data-root')
    const syncRoot = join(tempUserData, 'agent-sync')
    //  硬切布局：messages.jsonl 在
    // `{dataRoot}/users/{userId}/organizations/{orgId}/workspaces/{workspaceId}/conversations/sessions/{sid}/`
    const usersRoot = join(dataRoot, 'users')
    const workspaceA = join(usersRoot, 'u-1', 'organizations', 'wt-1', 'workspaces', 'ws-A', 'conversations', 'sessions', 'sess-1')
    const workspaceB = join(usersRoot, 'u-1', 'organizations', 'wt-1', 'workspaces', 'ws-B', 'conversations', 'sessions', 'sess-2')
    mkdirSync(workspaceA, { recursive: true })
    mkdirSync(workspaceB, { recursive: true })
    writeFileSync(join(workspaceA, 'messages.jsonl'), 'A'.repeat(100))
    writeFileSync(join(workspaceB, 'messages.jsonl'), 'B'.repeat(200))

    const { registerAgentStorageBuckets, __resetAgentBucketsCacheForTesting } =
      await import('../agent/platform/agent-storage-buckets')
    __resetAgentBucketsCacheForTesting()
    registerAgentStorageBuckets({
      dataRoot,
      syncRoot,
      getCurrentOwner: async () => ({ userId: 'u-1', organizationId: 'wt-1' }),
    })

    const items = await sm.listBucketItems('agent:conversations:messages')
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({ workspaceId: 'ws-A' }),
        }),
        expect.objectContaining({
          metadata: expect.objectContaining({ workspaceId: 'ws-B' }),
        }),
      ]),
    )

    // 只清 Workspace A
    const result = await sm.clearBucket('agent:conversations:messages', {
      itemIds: ['u-1/wt-1/ws-A'],
    })
    expect(result.clearedItemCount).toBe(1)
    expect(result.freedBytes).toBe(100)

    // Workspace B 应仍然存在
    const fs = await import('node:fs')
    expect(fs.existsSync(join(workspaceA, 'messages.jsonl'))).toBe(false)
    expect(fs.existsSync(join(workspaceB, 'messages.jsonl'))).toBe(true)
  })

  it('存储统计、下钻和整桶清理覆盖当前账号的全部组织，但不包含其他账号', async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const dataRoot = join(tempUserData, 'data-root')
    const syncRoot = join(tempUserData, 'agent-sync')
    const currentSession = join(
      dataRoot,
      'users', 'u-current',
      'organizations', 'org-current',
      'workspaces', 'ws-current',
      'conversations', 'sessions', 'sess-current',
    )
    const otherSession = join(
      dataRoot,
      'users', 'u-other',
      'organizations', 'org-other',
      'workspaces', 'ws-other',
      'conversations', 'sessions', 'sess-other',
    )
    const currentUserOtherOrganizationSession = join(
      dataRoot,
      'users', 'u-current',
      'organizations', 'org-another',
      'workspaces', 'ws-another',
      'conversations', 'sessions', 'sess-another',
    )
    mkdirSync(currentSession, { recursive: true })
    mkdirSync(currentUserOtherOrganizationSession, { recursive: true })
    mkdirSync(otherSession, { recursive: true })
    const currentFile = join(currentSession, 'messages.jsonl')
    const currentUserOtherOrganizationFile = join(
      currentUserOtherOrganizationSession,
      'messages.jsonl',
    )
    const otherFile = join(otherSession, 'messages.jsonl')
    writeFileSync(currentFile, 'C'.repeat(100))
    writeFileSync(currentUserOtherOrganizationFile, 'A'.repeat(150))
    writeFileSync(otherFile, 'O'.repeat(200))

    const { registerAgentStorageBuckets, __resetAgentBucketsCacheForTesting } =
      await import('../agent/platform/agent-storage-buckets')
    __resetAgentBucketsCacheForTesting()
    registerAgentStorageBuckets({
      dataRoot,
      syncRoot,
      getCurrentOwner: async () => ({
        userId: 'u-current',
        organizationId: 'org-current',
      }),
    })

    const size = await sm.getBucketSize('agent:conversations:messages')
    expect(size.bytes).toBe(250)
    expect(size.itemCount).toBe(2)

    const items = await sm.listBucketItems('agent:conversations:messages')
    expect(items.map(item => item.id).sort()).toEqual([
      'u-current/org-another/ws-another',
      'u-current/org-current/ws-current',
    ])

    const result = await sm.clearBucket('agent:conversations:messages')
    expect(result.clearedItemCount).toBe(2)
    expect(result.freedBytes).toBe(250)
    expect(existsSync(currentFile)).toBe(false)
    expect(existsSync(currentUserOtherOrganizationFile)).toBe(false)
    expect(existsSync(otherFile)).toBe(true)
  })

  it('无法解析当前身份时拒绝统计、下钻和清理', async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
    const dataRoot = join(tempUserData, 'data-root')
    const syncRoot = join(tempUserData, 'agent-sync')
    const sessionDir = join(
      dataRoot,
      'users', 'u-1',
      'organizations', 'org-1',
      'workspaces', 'ws-1',
      'conversations', 'sessions', 'sess-1',
    )
    mkdirSync(sessionDir, { recursive: true })
    const messagesFile = join(sessionDir, 'messages.jsonl')
    writeFileSync(messagesFile, 'secret')

    const { registerAgentStorageBuckets, __resetAgentBucketsCacheForTesting } =
      await import('../agent/platform/agent-storage-buckets')
    __resetAgentBucketsCacheForTesting()
    registerAgentStorageBuckets({
      dataRoot,
      syncRoot,
      getCurrentOwner: async () => null,
    })

    expect(await sm.getBucketSize('agent:conversations:messages')).toMatchObject({
      bytes: 0,
      itemCount: 0,
    })
    expect(await sm.listBucketItems('agent:conversations:messages')).toEqual([])
    expect(await sm.clearBucket('agent:conversations:messages')).toMatchObject({
      clearedItemCount: 0,
      freedBytes: 0,
    })
    expect(existsSync(messagesFile)).toBe(true)
  })
})

describe('checkpoint 存储按当前账号隔离', () => {
  it('组织切换不改变当前账号总量，账号切换后不会复用上一账号的缓存', async () => {
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()

    const rootA = join(tempUserData, 'users', 'u-a', 'organizations', 'org-a', 'checkpoints')
    const rootA2 = join(tempUserData, 'users', 'u-a', 'organizations', 'org-a2', 'checkpoints')
    const rootB = join(tempUserData, 'users', 'u-b', 'organizations', 'org-b', 'checkpoints')
    for (const [root, hashes] of [
      [rootA, ['hash-a']] as const,
      [rootA2, ['hash-a2']] as const,
      [rootB, ['hash-b1', 'hash-b2']] as const,
    ]) {
      for (const hash of hashes) {
        const gitDir = join(root, hash, '.git')
        mkdirSync(gitDir, { recursive: true })
        writeFileSync(join(gitDir, 'config'), '[core]\n\tworktree = C:/workspace/project\n')
      }
    }

    let currentRoots = [
      { organizationId: 'org-a', checkpointsRoot: rootA },
      { organizationId: 'org-a2', checkpointsRoot: rootA2 },
    ]
    vi.doMock('../logger', () => ({
      createLogger: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }),
    }))
    vi.doMock('../auth', () => ({ isTrustedSender: () => true }))
    vi.doMock('../utils/guarded-handle', () => ({ guardedHandle: vi.fn() }))
    vi.doMock('../checkpoint/CheckpointService', () => ({
      getCheckpointService: vi.fn(),
      destroyCheckpointServiceAtRoot: vi.fn(),
      getCurrentUserCheckpointRoots: () => currentRoots,
    }))

    const ipc = await import('../checkpoint/checkpoint-ipc')
    ipc.registerCheckpointStorageBucket()

    await expect(sm.getBucketSize('checkpoint:shadow-git')).resolves.toMatchObject({
      itemCount: 2,
    })
    currentRoots.reverse()
    await expect(sm.getBucketSize('checkpoint:shadow-git')).resolves.toMatchObject({
      itemCount: 2,
    })
    currentRoots = [{ organizationId: 'org-b', checkpointsRoot: rootB }]
    await expect(sm.getBucketSize('checkpoint:shadow-git')).resolves.toMatchObject({
      itemCount: 2,
    })
    currentRoots = []
    await expect(sm.getBucketSize('checkpoint:shadow-git')).resolves.toEqual({
      bytes: 0,
      itemCount: 0,
    })
    await expect(sm.listBucketItems('checkpoint:shadow-git')).resolves.toEqual([])
  })
})
