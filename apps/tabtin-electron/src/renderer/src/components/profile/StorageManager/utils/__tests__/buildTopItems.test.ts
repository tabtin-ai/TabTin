/**
 * buildStorageTopItems 守护测试 v4 —— 守减压重设第三轮的核心产品契约。
 *
 * v4 关键产品决策（与 v3 的差异）：
 *   - 拆 conversation-bundle 和 checkpoint-bundle 成两个独立 TopItem
 *     （v3 把对话按工作区聚合 + 项目快照按 cwdHash 聚合混在一个 bundle 里
 *     导致用户看不懂单位是工作区还是项目）
 *   - 加 UUID regex 兜底：任何 label 看起来像 UUID 的项强制合到「其他」
 *
 * 守的契约：
 *
 *   C1 Voice 露出：voice:hotwords-rules / system:voice-settings 即使 hideFromList=true
 *      也必须在 Top 列表（D-5 核心资产）
 *   C2 cache 合并：所有 category=cache 合 ONE "临时缓存" TopItem
 *   C3a conversation 独立 bundle（不含 checkpoint），单位 = Workspace（工作区）
 *   C3b checkpoint 独立 bundle（不含 conversation），单位 = git 项目
 *   C4 UUID 不裸露：名称映射不到时统一归入“其他工作区”
 *   C5 browser-env 合并：env-partitions 类合 ONE，drillItems 按 env 拆
 *   C6 Top N 切片（默认 6），按 bytes 倒序
 *   C7 空数据过滤：bytes=0 + itemCount=0 不出现
 *   C8 drillTopN 超出合到「其他」
 *   C9 真实数据冒烟：conv 和 checkpoint 独立、UUID 不漏
 */

import { describe, it, expect, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { buildStorageTopItems } from '../buildTopItems'
import type {
  BucketDescriptor,
  BucketItem,
  BucketSizeReport,
  ListItemsHandler,
} from '../../components/types'

const t = ((key: string, opts?: { defaultValue?: string; count?: number; id?: string }) => {
  let v = opts?.defaultValue ?? key
  if (typeof opts?.count === 'number') {
    v = v.replace('{{count}}', String(opts.count))
  }
  if (typeof opts?.id === 'string') {
    v = v.replace('{{id}}', opts.id)
  }
  return v
}) as unknown as TFunction

function descriptor(
  overrides: Partial<BucketDescriptor> & { id: string },
): BucketDescriptor {
  return {
    category: 'data',
    group: 'business-app',
    displayName: overrides.id,
    description: '',
    requiresConfirmation: 'soft',
    hideFromList: false,
    capabilities: { canList: false, canClear: true, canExport: false },
    ...overrides,
  }
}

function sizeOf(bytes: number, itemCount?: number): BucketSizeReport {
  return { id: 'x', bytes, itemCount, measuredAt: 0 }
}

function makeListItemsMock(
  itemsByBucket: Record<string, BucketItem[]>,
): ListItemsHandler {
  return vi.fn(async (id: string) => ({
    id,
    items: itemsByBucket[id] ?? [],
    measuredAt: 0,
  }))
}

// ── C1: Voice 露出 ───────────────────────────────────────────────

describe('v4 — C1 Voice 露出', () => {
  it('voice:hotwords-rules 即使 hideFromList=true 也在 Top 里', async () => {
    const descriptors = [
      descriptor({
        id: 'voice:hotwords-rules',
        group: 'system',
        category: 'data',
        hideFromList: true,
      }),
    ]
    const sizeMap = { 'voice:hotwords-rules': sizeOf(1024, 10) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    expect(
      result.allItems.find((it) => it.kind === 'voice-settings'),
    ).toBeTruthy()
  })

  it('system:voice-settings 即使 hideFromList=true 也在 Top 里', async () => {
    const descriptors = [
      descriptor({
        id: 'system:voice-settings',
        group: 'system',
        category: 'data',
        hideFromList: true,
      }),
    ]
    const sizeMap = { 'system:voice-settings': sizeOf(2048, 20) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    expect(
      result.allItems.find((it) =>
        it.bucketIds.includes('system:voice-settings'),
      ),
    ).toBeTruthy()
  })
})

describe('checkpoint file-history workspace grouping', () => {
  it('同一工作区的多条文件回退备份合并为一个项目', async () => {
    const result = await buildStorageTopItems({
      descriptors: [
        descriptor({
          id: 'checkpoint:shadow-git',
          group: 'checkpoint',
          capabilities: { canList: true, canClear: true, canExport: false },
        }),
        descriptor({
          id: 'checkpoint:file-history',
          group: 'checkpoint',
          capabilities: { canList: true, canClear: true, canExport: false },
        }),
      ],
      sizeMap: {
        'checkpoint:shadow-git': sizeOf(28_000, 1),
        'checkpoint:file-history': sizeOf(3_438, 2),
      },
      onListItems: makeListItemsMock({
        'checkpoint:shadow-git': [{
          id: 'shadow',
          label: '',
          bytes: 28_000,
          metadata: {
            organizationId: 'org-1',
            cwdHash: 'hash-1',
            projectPath: 'C:\\TabTin\\默认工作空间-3',
          },
        }],
        'checkpoint:file-history': [
          {
            id: 'thread-a',
            label: '',
            bytes: 3_112,
            metadata: {
              organizationId: 'org-1',
              workspaceId: 'workspace-1',
              workspaceRoot: 'C:\\TabTin\\默认工作空间-3',
            },
          },
          {
            id: 'thread-b',
            label: '',
            bytes: 326,
            metadata: {
              organizationId: 'org-1',
              workspaceId: 'workspace-1',
              workspaceRoot: 'C:\\TabTin\\默认工作空间-3',
            },
          },
        ],
      }),
      spaceNameMap: new Map(),
      organizationNameMap: new Map([['org-1', '蜂巢团队']]),
      t,
    })

    const checkpoints = result.allItems.find(item => item.kind === 'checkpoint-bundle')
    expect(checkpoints?.subtitle).toContain('1')
    expect(checkpoints?.drillItems).toHaveLength(1)
    expect(checkpoints?.drillItems?.[0]).toMatchObject({
      label: '默认工作空间-3 · 蜂巢团队',
      bytes: 31_438,
      itemCount: 3,
    })
  })
})

// ── C2: cache 合并 ────────────────────────────────────────────────

describe('v4 — C2 cache 合 ONE', () => {
  it('多个 cache bucket 合 ONE cache-bundle', async () => {
    const descriptors = [
      descriptor({
        id: 'cache:gpu',
        category: 'cache',
        group: 'cache',
        requiresConfirmation: 'none',
      }),
      descriptor({
        id: 'cache:http',
        category: 'cache',
        group: 'browser',
        requiresConfirmation: 'none',
      }),
    ]
    const sizeMap = {
      'cache:gpu': sizeOf(1000),
      'cache:http': sizeOf(2000),
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    const cacheBundles = result.allItems.filter(
      (it) => it.kind === 'cache-bundle',
    )
    expect(cacheBundles).toHaveLength(1)
    expect(cacheBundles[0].bytes).toBe(3000)
    expect(cacheBundles[0].canClear).toBe(true)
  })
})

// ── C3a: conversation 独立 bundle ────────────────────────────────

describe('v4 — C3a conversation 独立 bundle（单位 = Workspace）', () => {
  it('conversation 类合 ONE conversation-bundle，不含 checkpoint', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'agent:snapshots',
        category: 'semi-cache',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        // 注意：这个不应出现在 conversation-bundle 里
        id: 'checkpoint:shadow-git',
        category: 'data',
        group: 'checkpoint',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = {
      'agent:messages': sizeOf(500),
      'agent:snapshots': sizeOf(200),
      'checkpoint:shadow-git': sizeOf(800),
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'agent:messages': [
          { id: 'm1', label: '', bytes: 500, metadata: { spaceId: 'sp1' } },
        ],
        'agent:snapshots': [
          { id: 's1', label: '', bytes: 200, metadata: { spaceId: 'sp1' } },
        ],
        'checkpoint:shadow-git': [
          {
            id: 'p1',
            label: '',
            bytes: 800,
            metadata: { cwdHash: 'h1', projectName: 'TabTinAgent' },
          },
        ],
      }),
      spaceNameMap: new Map([['sp1', '小豆子']]),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv).toBeTruthy()
    expect(conv?.bytes).toBe(700) // 500+200，不包含 checkpoint 的 800
    expect(conv?.bucketIds).toEqual(
      expect.arrayContaining(['agent:messages', 'agent:snapshots']),
    )
    expect(conv?.bucketIds).not.toContain('checkpoint:shadow-git')
  })

  it('不展示缺少账号归属而被隐藏的对话类存储桶', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'agent:run-events',
        group: 'conversation',
        hideFromList: true,
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const onListItems = makeListItemsMock({
      'agent:messages': [
        { id: 'm1', label: '', bytes: 100, metadata: { workspaceId: 'ws-1' } },
      ],
      'agent:run-events': [
        { id: 'legacy-run', label: '', bytes: 900, metadata: {} },
      ],
    })

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap: {
        'agent:messages': sizeOf(100),
        'agent:run-events': sizeOf(900),
      },
      onListItems,
      spaceNameMap: new Map([['ws-1', '当前工作区']]),
      t,
    })

    const conversation = result.allItems.find(
      (item) => item.kind === 'conversation-bundle',
    )
    expect(conversation?.bytes).toBe(100)
    expect(conversation?.bucketIds).toEqual(['agent:messages'])
    expect(onListItems).not.toHaveBeenCalledWith('agent:run-events')
  })

  it('drillItems 用工作区名（不暴露历史 spaceId）', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'agent:messages': sizeOf(700) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'agent:messages': [
          { id: 'm1', label: '', bytes: 500, metadata: { spaceId: 'sp1' } },
          { id: 'm2', label: '', bytes: 200, metadata: { spaceId: 'sp2' } },
        ],
      }),
      spaceNameMap: new Map([
        ['sp1', '小豆子'],
        ['sp2', 'midscene'],
      ]),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    const labels = conv?.drillItems?.map((d) => d.label) ?? []
    expect(labels).toContain('小豆子')
    expect(labels).toContain('midscene')
  })

  it('没有 workspaceId 的数据单列展示且不计入工作区数量', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap: { 'agent:messages': sizeOf(1100) },
      onListItems: makeListItemsMock({
        'agent:messages': Array.from({ length: 49 }, (_, index) => ({
          id: `message-${index}`,
          label: '',
          bytes: 22,
          metadata: {},
        })),
      }),
      spaceNameMap: new Map(),
      t,
    })

    const conversation = result.allItems.find(
      (item) => item.kind === 'conversation-bundle',
    )
    expect(conversation?.subtitle).toBe('来自 0 个工作区')
    expect(conversation?.drillItems).toHaveLength(1)
    expect(conversation?.drillItems?.[0]).toMatchObject({
      label: '其他对话数据',
      itemCount: 49,
    })
  })
})

// ── C3b: checkpoint 独立 bundle ──────────────────────────────────

describe('v4 — C3b checkpoint 独立 bundle（单位 = git 项目）', () => {
  it('checkpoint 类合 ONE checkpoint-bundle，不含 conversation', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'checkpoint:shadow-git',
        category: 'data',
        group: 'checkpoint',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = {
      'agent:messages': sizeOf(100),
      'checkpoint:shadow-git': sizeOf(500),
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'agent:messages': [
          { id: 'm1', label: '', bytes: 100, metadata: { spaceId: 'sp1' } },
        ],
        'checkpoint:shadow-git': [
          {
            id: 'p1',
            label: '',
            bytes: 300,
            metadata: { cwdHash: 'h1', projectName: 'midscene' },
          },
          {
            id: 'p2',
            label: '',
            bytes: 200,
            metadata: { cwdHash: 'h2', projectName: 'TabTinAgent' },
          },
        ],
      }),
      spaceNameMap: new Map([['sp1', '小豆子']]),
      t,
    })

    const ckp = result.allItems.find((it) => it.kind === 'checkpoint-bundle')
    expect(ckp).toBeTruthy()
    expect(ckp?.bytes).toBe(500)
    expect(ckp?.bucketIds).toEqual(['checkpoint:shadow-git'])
    expect(ckp?.bucketIds).not.toContain('agent:messages')

    const drillLabels = ckp?.drillItems?.map((d) => d.label) ?? []
    expect(drillLabels).toContain('midscene')
    expect(drillLabels).toContain('TabTinAgent')
  })

  it('checkpoint 项的 projectName 是 UUID 时合到「其他项目」（关键 v4 修复）', async () => {
    const descriptors = [
      descriptor({
        id: 'checkpoint:shadow-git',
        category: 'data',
        group: 'checkpoint',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'checkpoint:shadow-git': sizeOf(300) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'checkpoint:shadow-git': [
          {
            id: 'p1',
            label: '',
            bytes: 100,
            metadata: {
              cwdHash: 'h1',
              projectName: 'c8346f92-9613-4a1c-b4f2-597017a3ed6d',
            },
          },
          {
            id: 'p2',
            label: '',
            bytes: 100,
            metadata: {
              cwdHash: 'h2',
              projectName: '98b91af3-c18e-4f8d-92ca-27c7ba403e1f',
            },
          },
          {
            id: 'p3',
            label: '',
            bytes: 100,
            metadata: { cwdHash: 'h3', projectName: 'midscene' },
          },
        ],
      }),
      spaceNameMap: new Map(),
      t,
    })

    const ckp = result.allItems.find((it) => it.kind === 'checkpoint-bundle')
    expect(ckp?.drillItems).toHaveLength(2) // midscene + 其他
    const labels = ckp?.drillItems?.map((d) => d.label) ?? []
    expect(labels).toContain('midscene')
    expect(labels.some((l) => l.match(/未归属|Unassigned/))).toBe(true)
    // 没有任何 drill label 包含 UUID
    for (const l of labels) {
      expect(l).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
    }
  })
})

// ── C4: UUID 不裸露 ──────────────────────────────────────────────

describe('v4 — C4 UUID 不裸露', () => {
  it('优先用 workspaceId 将对话数据归属到工作区', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap: { 'agent:messages': sizeOf(300) },
      onListItems: makeListItemsMock({
        'agent:messages': [
          {
            id: 'm1',
            label: '',
            bytes: 300,
            metadata: {
              workspaceId: 'workspace-1',
              spaceId: 'legacy-space-id',
            },
          },
        ],
      }),
      spaceNameMap: new Map([['workspace-1', '我的工作区']]),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv?.drillItems).toHaveLength(1)
    expect(conv?.drillItems?.[0].label).toBe('我的工作区')
    expect(conv?.subtitle).toBe('来自 1 个工作区')
  })

  it('名称映射不到时按 workspaceId 计数但统一展示为其他工作区', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'agent:messages': sizeOf(300) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'agent:messages': [
          {
            id: 'm1',
            label: '',
            bytes: 100,
            metadata: { workspaceId: '98b91af3-c18e-4f8d-92ca-27c7ba403e1f' },
          },
          {
            id: 'm2',
            label: '',
            bytes: 100,
            metadata: { workspaceId: 'd60f9b40-7e6b-4f0b-bd5b-f568c9f179e6' },
          },
        ],
      }),
      spaceNameMap: new Map(),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv?.drillItems).toHaveLength(1)
    expect(conv?.drillItems?.[0].label).toBe('其他工作区')
    expect(conv?.subtitle).toBe('来自 2 个工作区')
  })

  it('4 项工作区数据与 7 项辅助数据使用不同统计口径', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const workspaceId = '038297da-e547-434e-b036-3aade1330388'

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap: { 'agent:messages': sizeOf(38 * 1024 * 1024, 11) },
      onListItems: makeListItemsMock({
        'agent:messages': [
          ...Array.from({ length: 4 }, (_, index) => ({
            id: `workspace-item-${index}`,
            label: '',
            bytes: index === 0 ? 37 * 1024 * 1024 : 0,
            metadata: { workspaceId },
          })),
          ...Array.from({ length: 7 }, (_, index) => ({
            id: `auxiliary-item-${index}`,
            label: '',
            bytes: index === 0 ? 872 * 1024 : 0,
            metadata: {},
          })),
        ],
      }),
      spaceNameMap: new Map(),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv?.subtitle).toBe('来自 1 个工作区')
    expect(conv?.drillItems).toHaveLength(2)
    expect(conv?.drillItems?.[0]).toMatchObject({ label: '其他工作区', itemCount: 4 })
    expect(conv?.drillItems?.[1]).toMatchObject({ label: '其他对话数据', itemCount: 7 })
  })

  it('工作区名称本身是 UUID 时归入其他工作区', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'agent:messages': sizeOf(100) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'agent:messages': [
          {
            id: 'm1',
            label: '',
            bytes: 100,
            metadata: { spaceId: 'sp-with-uuid-name' },
          },
        ],
      }),
      spaceNameMap: new Map([
        // 工作区名称误填成 UUID（通用唯一标识符）
        ['sp-with-uuid-name', '98b91af3-c18e-4f8d-92ca-27c7ba403e1f'],
      ]),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv?.drillItems?.[0].label).toBe('其他工作区')
  })

  it('部分名称能解析时将未解析 workspaceId 归入其他工作区', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'agent:messages': sizeOf(300) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'agent:messages': [
          {
            id: 'm1',
            label: '',
            bytes: 200,
            metadata: { spaceId: 'sp-known' },
          },
          {
            id: 'm2',
            label: '',
            bytes: 100,
            metadata: { spaceId: 'sp-unknown-uuid-12345' },
          },
        ],
      }),
      spaceNameMap: new Map([['sp-known', '小豆子']]),
      t,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv?.drillItems).toHaveLength(2)
    const labels = conv?.drillItems?.map((d) => d.label) ?? []
    expect(labels).toContain('小豆子')
    expect(labels).toContain('其他工作区')
  })
})

// ── C5: browser-env 合并 ────────────────────────────────────────

describe('v4 — C5 browser-env 合 ONE', () => {
  it('env-partitions 合 ONE browser-env-bundle, drill 按 env 拆', async () => {
    const descriptors = [
      descriptor({
        id: 'browser:env-partitions',
        category: 'data',
        group: 'browser',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'browser:env-partitions': sizeOf(1000) }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        'browser:env-partitions': [
          {
            id: 'p1',
            label: '',
            bytes: 700,
            metadata: { env: 'default', envName: '默认环境' },
          },
          {
            id: 'p2',
            label: '',
            bytes: 300,
            metadata: { env: 'work', envName: '工作环境' },
          },
        ],
      }),
      spaceNameMap: new Map(),
      t,
    })

    const envBundles = result.allItems.filter(
      (it) => it.kind === 'browser-env-bundle',
    )
    expect(envBundles).toHaveLength(1)
    expect(envBundles[0].drillItems?.map((d) => d.label).sort()).toEqual(
      ['工作环境', '默认环境'].sort(),
    )
  })
})

// ── C6: Top N 切片 ──────────────────────────────────────────────

describe('v4 — C6 Top N 切片', () => {
  it('topItems 长度 ≤ topN（默认 6），按 bytes 倒序', async () => {
    const descriptors = Array.from({ length: 12 }, (_, i) =>
      descriptor({
        id: `media:item-${i}`,
        group: 'media',
        category: 'data',
      }),
    )
    const sizeMap: Record<string, BucketSizeReport> = {}
    for (let i = 0; i < 12; i++) {
      sizeMap[`media:item-${i}`] = sizeOf((12 - i) * 1000)
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    expect(result.topItems.length).toBeLessThanOrEqual(6)
    for (let i = 0; i < result.topItems.length - 1; i++) {
      expect(result.topItems[i].bytes).toBeGreaterThanOrEqual(
        result.topItems[i + 1].bytes,
      )
    }
  })
})

// ── C7: 空数据过滤 ──────────────────────────────────────────────

describe('v4 — C7 空数据过滤', () => {
  it('bytes=0 + itemCount=0 的项不出现', async () => {
    const descriptors = [
      descriptor({
        id: 'media:recordings',
        group: 'media',
        category: 'data',
      }),
      descriptor({
        id: 'media:empty',
        group: 'media',
        category: 'data',
      }),
    ]
    const sizeMap = {
      'media:recordings': sizeOf(1000, 5),
      'media:empty': sizeOf(0, 0),
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    expect(
      result.allItems.find((it) => it.bucketIds.includes('media:empty')),
    ).toBeUndefined()
    expect(
      result.allItems.find((it) => it.bucketIds.includes('media:recordings')),
    ).toBeTruthy()
  })
})

// ── C8: drillTopN 超出合到「其他」 ──────────────────────────────

describe('v4 — C8 drillTopN 超出合到「其他」', () => {
  it('15 个 Space → drillTopN=5 时 5 独立 + 1「其他」', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const sizeMap = { 'agent:messages': sizeOf(1500) }

    const spaceNames = new Map<string, string>()
    const items: BucketItem[] = []
    for (let i = 0; i < 15; i++) {
      spaceNames.set(`sp-${i}`, `Space ${i}`)
      items.push({
        id: `m${i}`,
        label: '',
        bytes: 100,
        metadata: { spaceId: `sp-${i}` },
      })
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({ 'agent:messages': items }),
      spaceNameMap: spaceNames,
      t,
      drillTopN: 5,
    })

    const conv = result.allItems.find((it) => it.kind === 'conversation-bundle')
    expect(conv?.drillItems?.length).toBe(6) // 5 + 1「其他」
    const last = conv?.drillItems?.[conv.drillItems.length - 1]
    expect(last?.label).toMatch(/其他|Other/)
    expect(last?.bytes).toBe(1000) // 10 项 × 100
    expect(last?.itemCount).toBe(10)
  })
})

// ── C9: 真实数据冒烟 ────────────────────────────────────────────

describe('v4 — C9 真实数据冒烟（用户实际截图的数据形态）', () => {
  it('conv + checkpoint 拆成两个 bundle、UUID 不漏', async () => {
    const descriptors: BucketDescriptor[] = [
      descriptor({
        id: 'agent:messages',
        category: 'data',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'checkpoint:shadow-git',
        category: 'data',
        group: 'checkpoint',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'browser:env-partitions',
        category: 'data',
        group: 'browser',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'browser:http-cache-aggregate',
        category: 'cache',
        group: 'browser',
        requiresConfirmation: 'none',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'system:voice-settings',
        category: 'data',
        group: 'system',
        hideFromList: true,
      }),
    ]
    const sizeMap = {
      'agent:messages': sizeOf(85 * 1024 * 1024),
      'checkpoint:shadow-git': sizeOf(820 * 1024 * 1024),
      'browser:env-partitions': sizeOf(520 * 1024 * 1024),
      'browser:http-cache-aggregate': sizeOf(50 * 1024 * 1024),
      'system:voice-settings': sizeOf(2048, 30),
    }

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap,
      onListItems: makeListItemsMock({
        // 对话：2 个真实 Space + 1 个未知 UUID
        'agent:messages': [
          {
            id: 'm1',
            label: '',
            bytes: 75 * 1024 * 1024,
            metadata: { spaceId: 'sp-doudou' },
          },
          {
            id: 'm2',
            label: '',
            bytes: 9 * 1024 * 1024,
            metadata: { spaceId: 'sp-default-agent' },
          },
          {
            id: 'm3',
            label: '',
            bytes: 1 * 1024 * 1024,
            metadata: { spaceId: 'sp-unknown-uuid-xxx' },
          },
        ],
        // 项目快照：3 个 git 项目 + 2 个 UUID 项目名
        'checkpoint:shadow-git': [
          {
            id: 'p1',
            label: '',
            bytes: 503 * 1024 * 1024,
            metadata: { cwdHash: 'h1', projectName: 'midscene' },
          },
          {
            id: 'p2',
            label: '',
            bytes: 129 * 1024 * 1024,
            metadata: { cwdHash: 'h2', projectName: 'TabTinAgent' },
          },
          {
            id: 'p3',
            label: '',
            bytes: 112 * 1024 * 1024,
            metadata: { cwdHash: 'h3', projectName: 'TabTinTable' },
          },
          {
            id: 'p4',
            label: '',
            bytes: 50 * 1024 * 1024,
            metadata: {
              cwdHash: 'h4',
              projectName: 'c8346f92-9613-4a1c-b4f2-597017a3ed6d',
            },
          },
          {
            id: 'p5',
            label: '',
            bytes: 26 * 1024 * 1024,
            metadata: {
              cwdHash: 'h5',
              projectName: '98b91af3-c18e-4f8d-92ca-27c7ba403e1f',
            },
          },
        ],
        'browser:env-partitions': [
          {
            id: 'env1',
            label: '',
            bytes: 520 * 1024 * 1024,
            metadata: { env: 'default', envName: '默认环境' },
          },
        ],
      }),
      spaceNameMap: new Map([
        ['sp-doudou', '小豆子'],
        ['sp-default-agent', '默认 Space'],
      ]),
      t,
    })

    // 关键 v4 契约：conv 和 checkpoint 各自独立 bundle
    const convs = result.allItems.filter(
      (it) => it.kind === 'conversation-bundle',
    )
    const ckps = result.allItems.filter(
      (it) => it.kind === 'checkpoint-bundle',
    )
    expect(convs).toHaveLength(1)
    expect(ckps).toHaveLength(1)

    // conv 下：小豆子、默认 Space、工作区短标识
    expect(convs[0].drillItems?.length).toBe(3)
    const convLabels = convs[0].drillItems?.map((d) => d.label) ?? []
    expect(convLabels).toContain('小豆子')
    expect(convLabels).toContain('默认 Space')
    expect(convLabels[convLabels.length - 1]).toBe('工作区 sp-unkno…')

    // checkpoint 下：midscene、TabTinAgent、TabTinTable、其他项目（合并 2 个 UUID 项目名）
    expect(ckps[0].drillItems?.length).toBe(4)
    expect(ckps[0].subtitle).toBe('3 个项目 · Agent 操作的撤销快照')
    const ckpLabels = ckps[0].drillItems?.map((d) => d.label) ?? []
    expect(ckpLabels).toContain('midscene')
    expect(ckpLabels).toContain('TabTinAgent')
    expect(ckpLabels).toContain('TabTinTable')
    expect(ckpLabels[ckpLabels.length - 1]).toMatch(/未归属|Unassigned/)
    const ckpOther = ckps[0].drillItems?.find((d) =>
      d.label.match(/未归属|Unassigned/),
    )
    expect(ckpOther?.bytes).toBe(76 * 1024 * 1024) // 50+26 MB

    // 任何 drill label 都不包含 UUID
    for (const top of [...convs, ...ckps]) {
      for (const drill of top.drillItems ?? []) {
        expect(drill.label).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
      }
    }

    // 第一名应是 checkpoint-bundle（820 MB > envs 520 MB > conv 85 MB）
    expect(result.topItems[0].kind).toBe('checkpoint-bundle')

    // Voice + cache 都在
    expect(
      result.allItems.find((it) => it.kind === 'voice-settings'),
    ).toBeTruthy()
    expect(
      result.allItems.find((it) => it.kind === 'cache-bundle'),
    ).toBeTruthy()
  })
})

describe('v4 — 内部存储桶不进入用户聚合', () => {
  it('隐藏同步待处理和同步归档，不生成其他对话数据', async () => {
    const descriptors = [
      descriptor({
        id: 'agent:sync-pending',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
      descriptor({
        id: 'agent:sync-archive',
        group: 'conversation',
        capabilities: { canList: true, canClear: true, canExport: false },
      }),
    ]
    const onListItems = makeListItemsMock({
      'agent:sync-pending': [{ id: 'pending', label: '', bytes: 100 }],
      'agent:sync-archive': [{ id: 'archive', label: '', bytes: 200 }],
    })

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap: {
        'agent:sync-pending': sizeOf(100),
        'agent:sync-archive': sizeOf(200),
      },
      onListItems,
      spaceNameMap: new Map(),
      t,
    })

    expect(result.allItems).not.toContainEqual(
      expect.objectContaining({ kind: 'conversation-bundle' }),
    )
    expect(onListItems).not.toHaveBeenCalled()
  })

  it('隐藏自动注入的 Agent 工具脚本，也不把空注册表算作已安装应用', async () => {
    const descriptors = [
      descriptor({
        id: 'skills:preinstalled',
        group: 'business-app',
        category: 'semi-cache',
      }),
      descriptor({
        id: 'marketplace:apps',
        group: 'business-app',
        category: 'data',
      }),
    ]

    const result = await buildStorageTopItems({
      descriptors,
      sizeMap: {
        'skills:preinstalled': sizeOf(15_000, 16),
        'marketplace:apps': sizeOf(2, 0),
      },
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    expect(result.allItems).not.toContainEqual(
      expect.objectContaining({ kind: 'app-bundle' }),
    )
  })

  it('下载历史只作为一个媒体数据类别展示一次', async () => {
    const result = await buildStorageTopItems({
      descriptors: [
        descriptor({
          id: 'download:user-downloads',
          group: 'media',
          category: 'data',
        }),
      ],
      sizeMap: { 'download:user-downloads': sizeOf(4_100, 2) },
      onListItems: makeListItemsMock({}),
      spaceNameMap: new Map(),
      t,
    })

    expect(
      result.allItems.filter((item) =>
        item.bucketIds.includes('download:user-downloads'),
      ),
    ).toHaveLength(1)
  })
})
