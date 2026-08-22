/**
 * W2.2 G1 北极星集成验收：listBuckets({ group: 'business-app' }) 覆盖剩余业务桶。
 *
 * **R3-1 修复**：原版本是用本地 stub 构造 10 个桶——任何业务模块改名 / 注册函数失效，
 * 该测试都会"假绿"。本版改成真正 import 业务模块的注册函数，再断言注册成功。
 *
 * 覆盖：
 *   - main 进程 4 个 bucket：直接 import 4 个 register 函数，调用后 getBucket 拿到真值
 *   - renderer 进程 2 个 bucket：声明性核对（这些桶的注册位置见 RFC §五；
 *     具体 jsdom 集成测在各 packages/* 子项目内单独跑，避免 main 进程 vitest
 *     拉 renderer-only 副作用）
 *
 * 强约束：所有 bucket id 必须出现在 BUCKET_TRUTH_TABLE 中——执行 Agent
 * 漏注册或改 id 都会被这个表抓出来。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  __resetForTesting,
  listBuckets,
  getBucket,
} from '@tabtin/storage-manager'

// ── electron / native mocks ─────────────────────────────────────

const { mockClearStorageData, mockFromPartition } = vi.hoisted(() => {
  const mockClearStorageData = vi.fn(() => Promise.resolve())
  const mockFromPartition = vi.fn(() => ({ clearStorageData: mockClearStorageData }))
  return { mockClearStorageData, mockFromPartition }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return '/tmp/__tabtin_w22g1_test_userdata__'
      return '/tmp/__tabtin_w22g1_test__'
    }),
    getVersion: vi.fn(() => '0.0.0-test'),
    getLocale: vi.fn(() => 'zh-CN'),
    getName: vi.fn(() => 'tabtin-test'),
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
    on: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  net: { fetch: vi.fn() },
  session: { fromPartition: mockFromPartition },
}))

vi.mock('@tabtin/shared/storage-paths', () => ({
  getDataRoot: vi.fn(() => '/tmp/__tabtin_w22g1_test_dataroot__'),
  getDaemonHomePath: vi.fn(() => '/tmp/__tabtin_w22g1_test_daemon__'),
  getHomeTabtinPath: vi.fn(() => '/tmp/__tabtin_w22g1_test_home__'),
}))

vi.mock('@tabtin/terminal-core', () => ({
  resolveUserSkillsDir: (dataRoot: string, userId: string) =>
    `${dataRoot}/users/${userId}/skills`,
  resolveOrganizationSkillsDir: (dataRoot: string, userId: string, orgId: string) =>
    `${dataRoot}/users/${userId}/organizations/${orgId}/skills`,
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}))

vi.mock('../../utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
}))

// 隔离 MCP SDK：注册路径无需真正 import client，仅类型签名即可
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: class {} }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class {} }))

// ── truth table ─────────────────────────────────────────────────

interface BucketTruth {
  id: string
  category: 'cache' | 'semi-cache' | 'data'
  group: 'business-app'
  process: 'main' | 'renderer'
}

const BUCKET_TRUTH_TABLE: BucketTruth[] = [
  { id: 'tabdoc:offline-drafts', category: 'data', group: 'business-app', process: 'renderer' },
  { id: 'tabslide:offline-overflow', category: 'data', group: 'business-app', process: 'renderer' },
  { id: 'tin:sandboxes', category: 'semi-cache', group: 'business-app', process: 'main' },
  { id: 'marketplace:apps', category: 'semi-cache', group: 'business-app', process: 'main' },
  { id: 'skills:preinstalled', category: 'semi-cache', group: 'business-app', process: 'main' },
  { id: 'mcp:local-connections', category: 'data', group: 'business-app', process: 'main' },
]

const MAIN_PROCESS_BUCKETS = BUCKET_TRUTH_TABLE.filter((b) => b.process === 'main')

// ── tests ───────────────────────────────────────────────────────

describe('W2.2 G1 北极星 · 真集成', () => {
  beforeEach(() => {
    __resetForTesting()
    mockClearStorageData.mockClear()
    mockFromPartition.mockClear()
  })

  it('truth table 含 6 个 business-app bucket（命名清单稳定性）', () => {
    expect(BUCKET_TRUTH_TABLE).toHaveLength(6)
    const ids = BUCKET_TRUTH_TABLE.map((b) => b.id)
    expect(new Set(ids).size).toBe(6)
  })

  it('main 进程 4 个 bucket 真实 import + 注册：getBucket 拿得到，字段对得上', async () => {
    const { registerSkillsPreinstalledBucket } = await import('../SkillsBucketRegistration')
    const { registerMarketplaceAppsBucket } = await import('../MarketplaceAppInstaller')
    const { registerMcpLocalConnectionsBucket } = await import('../LocalMcpService')
    const { registerTinSandboxBucket } = await import('../../tins/tin-sandbox')

    registerSkillsPreinstalledBucket()
    registerMarketplaceAppsBucket()
    registerMcpLocalConnectionsBucket()
    registerTinSandboxBucket()

    for (const truth of MAIN_PROCESS_BUCKETS) {
      const bucket = getBucket(truth.id)
      expect(bucket, `${truth.id} 应已注册`).toBeDefined()
      expect(bucket?.category, `${truth.id} category`).toBe(truth.category)
      expect(bucket?.group, `${truth.id} group`).toBe(truth.group)
      expect(typeof bucket?.sizeFn, `${truth.id} sizeFn`).toBe('function')
    }

    const businessApp = listBuckets({ group: 'business-app' })
    expect(businessApp).toHaveLength(MAIN_PROCESS_BUCKETS.length)
  })

  it('renderer 2 个 bucket 在 truth table 里登记（实际注册由各 packages/* 子测试覆盖）', () => {
    const rendererBuckets = BUCKET_TRUTH_TABLE.filter((b) => b.process === 'renderer')
    expect(rendererBuckets).toHaveLength(2)
    const expectedIds = [
      'tabdoc:offline-drafts',
      'tabslide:offline-overflow',
    ]
    expect(rendererBuckets.map((b) => b.id).sort()).toEqual(expectedIds.sort())
  })

  // R3 round-2 修复：marketplace clearFn 必须级联清 persist:marketplace-${appId} partition。
  // 单独建一个回归断言，防止以后被静默删掉。
  it('marketplace:apps clearFn 真实调用 session.fromPartition + clearStorageData', async () => {
    const { registerMarketplaceAppsBucket, getMarketplaceAppInstaller } = await import('../MarketplaceAppInstaller')
    registerMarketplaceAppsBucket()

    const bucket = getBucket('marketplace:apps')!
    expect(bucket).toBeDefined()

    // 注入一个伪 registry 让 clearFn 有实际 entry 可清
    const installer = getMarketplaceAppInstaller()
    vi.spyOn(installer, 'listInstalledApps').mockResolvedValue({
      'fake-app': {
        version: '1.0.0',
        installedAt: new Date().toISOString(),
        binaryPath: '/tmp/fake-app/bin/cli',
        manifestVersion: '1.0.0',
      },
    })
    vi.spyOn(installer, 'uninstallApp').mockResolvedValue(undefined)

    await bucket.clearFn!({})

    expect(mockFromPartition).toHaveBeenCalledWith('persist:marketplace-fake-app')
    expect(mockClearStorageData).toHaveBeenCalled()
  })
})
