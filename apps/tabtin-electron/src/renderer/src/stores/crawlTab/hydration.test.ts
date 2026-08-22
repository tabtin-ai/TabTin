/**
 * Crawl Tab hydration 模块单测 — Wave 3 L-W2-2 收敛。
 *
 * 重点覆盖 `normalizeTabs` 中老 workspace partition 字段的回填规则。
 * 这条逻辑是"BrowserEnv 完全本地化退役"链路的最后一环：
 *   - localStorage 中老数据可能没有 partition（pending 机制下兼容写入）
 *   - hydration 时根据 BrowserEnvSnapshot 回填正确 partition
 *   - 镜像未就绪时 fallback 到默认 env partition（不再写 legacy crawlspace 前缀）
 *
 * 三个核心场景：
 *   1. 老数据无 partition + mirror 已就绪 → 真实 env partition 回填
 *   2. 老数据无 partition + mirror 未就绪 → 默认 env partition 兜底
 *   3. 老数据已有 partition → 不动
 *
 * 不覆盖：tabsSlice 注册 listener 升级 partition 的链路（属于 tabsSlice
 * 集成测试范围）。这里只关心 hydration 这一帧的输出。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetBrowserEnvSnapshotForTests,
  ensureBrowserEnvSnapshotStarted,
  buildSessionPartition,
  DEFAULT_ENV_PARTITION,
} from '../browserEnvSnapshot'
import { normalizePersistedViews, normalizeTabs } from './hydration'

interface MockEnv {
  id: string
  name: string
  partition_key: string
  is_default: boolean
  binding_count: number
  explicit_binding_count: number
  using_space_count: number
  created_at: string
  updated_at: string
}

interface MockBinding {
  space_id: string
  environment_id: string
  is_explicit: boolean
}

function makeEnv(id: string, partition_key: string, isDefault = false): MockEnv {
  return {
    id, name: id, partition_key, is_default: isDefault,
    binding_count: 0, explicit_binding_count: 0, using_space_count: 0,
    created_at: '2026-01-01', updated_at: '2026-01-01',
  }
}

function installSnapshotMock(opts: {
  environments?: MockEnv[]
  bindings?: MockBinding[]
  /** true 表示让 list() 永不 resolve（模拟启动期镜像未就绪）。 */
  pending?: boolean
} = {}) {
  const envs = opts.environments ?? [makeEnv('default', DEFAULT_ENV_PARTITION, true)]
  const bindings = opts.bindings ?? []
  const pendingPromise = new Promise(() => { /* 永不 resolve */ })

  const list = opts.pending
    ? () => pendingPromise as Promise<unknown>
    : async () => ({ success: true, environments: envs, bindings })

  ;(globalThis as any).window = {
    tabtin: {
      browserEnv: {
        list,
        onChanged: () => () => undefined,
      },
    },
  }
}

describe('hydration.normalizeTabs — workspace partition 回填', () => {
  beforeEach(() => {
    __resetBrowserEnvSnapshotForTests()
    delete (globalThis as any).window
  })

  afterEach(() => {
    __resetBrowserEnvSnapshotForTests()
    delete (globalThis as any).window
  })

  it('老数据无 partition + mirror 已就绪 + 显式绑定 → 回填到真实 env partition', async () => {
    installSnapshotMock({
      environments: [
        makeEnv('default', DEFAULT_ENV_PARTITION, true),
        makeEnv('work', 'tabtin:env:work-uuid'),
      ],
      bindings: [{ space_id: 'space-A', environment_id: 'work', is_explicit: true }],
    })
    ensureBrowserEnvSnapshotStarted()
    // 等首次 IPC 完成
    await new Promise((r) => setTimeout(r, 0))

    const rawTabs = [
      {
        id: 'cs-1',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            spaceId: 'space-A',
            crawlspaceId: 'cs-1',
            // 注意：没有 partition 字段，模拟老数据
            profile: 'default',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe('tabtin:env:work-uuid')
    // crawlspaceId 应该被强制设为 tab.id（hydration 自动对齐契约）
    expect(config.crawlspaceId).toBe('cs-1')
  })

  it('老数据无 partition + mirror 已就绪 + 无显式绑定 → 回填到默认 env partition', async () => {
    installSnapshotMock({
      environments: [makeEnv('default', DEFAULT_ENV_PARTITION, true)],
      bindings: [],
    })
    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    const rawTabs = [
      {
        id: 'cs-2',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            spaceId: 'space-no-binding',
            crawlspaceId: 'cs-2',
            profile: 'default',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe(DEFAULT_ENV_PARTITION)
  })

  it('老数据无 partition + mirror 未就绪 → 默认 env partition 兜底（不写 legacy crawlspace 前缀）', () => {
    // mirror 未启动 + window.tabtin.browserEnv 不可用 → getPartitionForSpaceSync
    // 应立即返回默认 partition 而不是 pending / legacy 字面量。
    installSnapshotMock({ pending: true })
    // 故意不 await IPC，模拟"hydration 这一帧 mirror 还没拉到任何东西"
    // 但要触发 ensureBrowserEnvSnapshotStarted 让 listener 注册。

    const rawTabs = [
      {
        id: 'cs-3',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            spaceId: 'space-anything',
            crawlspaceId: 'cs-3',
            profile: 'default',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe(DEFAULT_ENV_PARTITION)
    // 不应该有任何 legacy `tabtin:crawlspace:` 字面量
    expect(config.partition).not.toMatch(/tabtin:crawlspace:/)
  })

  it('老数据已有 partition → 保留不动', () => {
    installSnapshotMock({
      environments: [
        makeEnv('default', DEFAULT_ENV_PARTITION, true),
        makeEnv('work', 'tabtin:env:work-uuid'),
      ],
      bindings: [{ space_id: 'space-A', environment_id: 'work', is_explicit: true }],
    })
    ensureBrowserEnvSnapshotStarted()

    const rawTabs = [
      {
        id: 'cs-4',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            spaceId: 'space-A',
            crawlspaceId: 'cs-4',
            // 历史固化的 partition；hydration 不应该悄悄改它
            partition: 'tabtin:env:legacy-pinned',
            profile: 'default',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe('tabtin:env:legacy-pinned')
  })

  it('BR-29：命名 session 无 partition → 回填为独立隔离 session partition（非 env）', async () => {
    installSnapshotMock({
      environments: [makeEnv('default', DEFAULT_ENV_PARTITION, true)],
      bindings: [],
    })
    ensureBrowserEnvSnapshotStarted()
    await new Promise((r) => setTimeout(r, 0))

    const rawTabs = [
      {
        id: 'cs-session-space1ab-cookie-test',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            spaceId: 'space-1ab',
            crawlspaceId: 'cs-session-space1ab-cookie-test',
            sessionName: 'cookie-test',
            profile: 'background-task',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe(buildSessionPartition('cs-session-space1ab-cookie-test'))
    expect(config.partition).not.toBe(DEFAULT_ENV_PARTITION)
    expect(config.partition.startsWith('tabtin:env:')).toBe(false)
  })

  it('BR-29 迁移：修复前落盘的命名 session（partition=env:default）→ 迁移到隔离 session partition', () => {
    installSnapshotMock({})

    const rawTabs = [
      {
        id: 'cs-session-space1ab-acct-b',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            spaceId: 'space-1ab',
            crawlspaceId: 'cs-session-space1ab-acct-b',
            sessionName: 'acct-b',
            // 修复前固化的共享 env partition —— 必须被迁移，否则继续共享真实登录态
            partition: DEFAULT_ENV_PARTITION,
            profile: 'background-task',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe(buildSessionPartition('cs-session-space1ab-acct-b'))
  })

  it('非 workspace tab 不受 partition 回填逻辑影响', () => {
    installSnapshotMock({})

    const rawTabs = [
      {
        id: 'normal-1',
        kind: 'normal',
        url: 'https://example.com',
        name: 'Example',
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    expect(normalized[0].kind).toBe('normal')
    // 普通 tab 没有 crawlspaceConfig，partition 字段也不会被构造出来
    expect((normalized[0].metadata as any)?.crawlspaceConfig).toBeUndefined()
  })

  it('rawConfig 无 spaceId / projectId → fallback 到默认 env partition', () => {
    installSnapshotMock({})
    ensureBrowserEnvSnapshotStarted()

    const rawTabs = [
      {
        id: 'cs-5',
        kind: 'workspace',
        url: '',
        metadata: {
          crawlspaceConfig: {
            // 没 spaceId 也没 projectId（极端老数据）
            crawlspaceId: 'cs-5',
            profile: 'default',
          },
        },
      },
    ]

    const normalized = normalizeTabs(rawTabs)
    const config = normalized[0].metadata?.crawlspaceConfig as any
    expect(config.partition).toBe(DEFAULT_ENV_PARTITION)
  })
})

describe('hydration.normalizePersistedViews — 种子字段跨重启保留', () => {
  it('localPreviewRoot 经 rehydration 保留（ file:// 预览恢复）', () => {
    const result = normalizePersistedViews({
      'cs-1': [
        {
          viewId: 'view-preview',
          url: 'file:///Users/me/workdir/report.html',
          title: 'report.html',
          localPreviewRoot: '/Users/me/workdir',
        },
        {
          viewId: 'view-normal',
          url: 'https://example.com',
          title: 'Example',
        },
      ],
    })

    const seeds = result['cs-1']
    expect(seeds).toHaveLength(2)
    expect(seeds[0].localPreviewRoot).toBe('/Users/me/workdir')
    // 普通网页种子不应凭空长出放行根
    expect(seeds[1].localPreviewRoot).toBeUndefined()
  })

  it('localPreviewRoot 非字符串 / 空串 → 归一化为 undefined（不放行）', () => {
    const result = normalizePersistedViews({
      'cs-1': [
        { viewId: 'v1', url: 'file:///a.html', localPreviewRoot: '' },
        { viewId: 'v2', url: 'file:///b.html', localPreviewRoot: 123 },
      ],
    })

    expect(result['cs-1'][0].localPreviewRoot).toBeUndefined()
    expect(result['cs-1'][1].localPreviewRoot).toBeUndefined()
  })

  it('openIntentHints 经 rehydration 保留并过滤非法空值（ signed URL 恢复）', () => {
    const result = normalizePersistedViews({
      'cs-1': [
        {
          viewId: 'view-signed',
          url: 'https://oss.example.com/download?id=asset-1',
          title: 'report.xlsx',
          openIntentHints: {
            filename: 'report.xlsx',
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            assetId: 'asset-1',
          },
        },
        {
          viewId: 'view-empty',
          url: 'https://oss.example.com/download?id=asset-2',
          title: 'download',
          openIntentHints: { filename: '', mimeType: 123 },
        },
      ],
    })

    expect(result['cs-1'][0].openIntentHints).toEqual({
      filename: 'report.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      assetId: 'asset-1',
    })
    expect(result['cs-1'][1].openIntentHints).toBeUndefined()
  })
})
