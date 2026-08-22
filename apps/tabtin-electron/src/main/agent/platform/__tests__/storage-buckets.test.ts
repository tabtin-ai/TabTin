/**
 * W2.2-G2 守护测试：验证 main 进程一系列对话/agent 工作面 bucket 接入
 * storage-manager 中心。
 *
 * 这一层是**源码契约层**——锁住 ElectronAgentHost 调用 register 入口、
 * checkpoint-ipc 暴露 registerCheckpointStorageBucket、EventPersistence
 * 顶层挂 register 等"调用关系不漂移"的不变量。
 *
 * **真实运行时行为**由 `apps/tabtin-electron/src/main/__tests__/
 * storage-buckets-e2e.test.ts` 守护——直接调用真实
 * `registerAgentStorageBuckets` + `getEventPersistence` +
 * `registerCheckpointStorageBucket`，验证 schema / 计数 / clearFn 行为。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const HOST_SRC = join(__dirname, '..', '..', 'ElectronAgentHost.ts')
const AGENT_BUCKETS_SRC = join(__dirname, '..', 'agent-storage-buckets.ts')
const EVENT_PERSISTENCE_SRC = join(__dirname, '..', '..', '..', 'run-session', 'EventPersistence.ts')
const CHECKPOINT_IPC_SRC = join(__dirname, '..', '..', '..', 'checkpoint', 'checkpoint-ipc.ts')

describe('W2.2-G2 storage-manager bucket 注册 — 源码契约', () => {
  it('ElectronAgentHost 在 start() 中调用 registerAgentStorageBuckets()', () => {
    const src = readFileSync(HOST_SRC, 'utf-8')
    expect(src).toMatch(/registerAgentStorageBuckets\(\{/)
  })

  it('agent-storage-buckets 注册了 7 个 agent:* / agent:conversations:* bucket id', () => {
    const src = readFileSync(AGENT_BUCKETS_SRC, 'utf-8')
    const requiredIds = [
      'agent:conversations:messages',
      'agent:conversations:snapshots',
      'agent:conversations:events',
      'agent:tool-logs',
      'agent:tool-results',
      'agent:sync-pending',
      'agent:sync-archive',
    ]
    for (const id of requiredIds) {
      expect(src.includes(`'${id}'`), `应注册 bucket: ${id}`).toBe(true)
    }
  })

  it('agent:sync-* clearFn 不会误删 syncRoot 本身（按 owner 分桶）', () => {
    // 关键不变量：sync clearFn 必须只删 owner 维度的子文件 / 子目录，
    // 永远不能 rmSync(syncRoot)。源码扫描验证 clearFn 体内不出现对
    // syncRoot 的递归删除。
    const src = readFileSync(AGENT_BUCKETS_SRC, 'utf-8')
    expect(src).not.toMatch(/fs\.(promises\.)?rm(Sync)?\(\s*syncRoot/)
  })

  it('agent:conversations:* clearFn 按 (userId, organizationId, workspaceId) 维度精准删除', () => {
    const src = readFileSync(AGENT_BUCKETS_SRC, 'utf-8')
    expect(src).toMatch(/targetSet\.has\(_workspaceLevelItemId\(s\.userId, s\.organizationId, s\.workspaceId\)\)/)
  })

  it('EventPersistence 注册 agent:run-events bucket', () => {
    const src = readFileSync(EVENT_PERSISTENCE_SRC, 'utf-8')
    expect(src).toMatch(/registerStorageBucket\(/)
    expect(src).toMatch(/'agent:run-events'/)
  })

  it('checkpoint-ipc 注册 checkpoint:shadow-git bucket', () => {
    const src = readFileSync(CHECKPOINT_IPC_SRC, 'utf-8')
    expect(src).toMatch(/'checkpoint:shadow-git'/)
    expect(src).toMatch(/registerCheckpointStorageBucket/)
  })
})

describe('W2.2-G2 storage-manager bucket 注册 — registry 集成', () => {
  // 重置 storage-manager singleton + mock 必要依赖。
  beforeEach(async () => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('调用 registerCheckpointStorageBucket 后 checkpoint:shadow-git 在 registry', async () => {
    vi.doMock('electron', () => ({
      app: { getPath: () => '/tmp/test-userdata' },
      ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
    }))
    vi.doMock('../../../logger', () => ({
      createLogger: () => ({
        info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      }),
    }))
    vi.doMock('../../../auth', () => ({ isTrustedSender: () => true }))
    vi.doMock('../../../utils/guarded-handle', () => ({ guardedHandle: vi.fn() }))
    vi.doMock('../../../download-security', () => ({ isPathSafe: () => true }))
    vi.doMock('../../../checkpoint/CheckpointService', () => ({
      getCheckpointService: vi.fn(),
      destroyCheckpointService: vi.fn(),
    }))

    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()

    const ipc = await import('../../../checkpoint/checkpoint-ipc')
    ipc.registerCheckpointStorageBucket()

    const buckets = sm.listBuckets({ group: 'checkpoint' })
    expect(buckets.length).toBeGreaterThanOrEqual(1)
    const cp = buckets.find(b => b.id === 'checkpoint:shadow-git')
    expect(cp, 'checkpoint:shadow-git 必须注册').toBeDefined()
    expect(cp?.category).toBe('data')
    expect(cp?.requiresConfirmation).toBe('hard')
    expect(Array.isArray(cp?.warnings) && cp!.warnings!.length >= 1).toBe(true)
  })
})
