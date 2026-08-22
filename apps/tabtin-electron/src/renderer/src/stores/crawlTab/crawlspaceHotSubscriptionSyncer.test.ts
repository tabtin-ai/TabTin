import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrawlspaceConfig } from './types'

// Mock release 函数 + workbench scene store。
// 注意：所有 mock 必须在 import syncer **之前** 完成，否则 syncer 模块顶部
// 的 import 已经拿到真实模块。
const mockRelease = vi.fn()
vi.mock('./crawlspaceContextSubscriptionRegistry', () => ({
  releaseCrawlspaceContextSubscription: (csId: string) => mockRelease(csId),
}))

let mockCrawlspaceConfigById: Record<string, { crawlspaceId: string; spaceId?: string }> = {}

// In-process useWorkbenchSceneStore mock —— 用最小行为模拟 zustand store。
type HotSceneState = { hotSceneIds: string[] }
type Listener = (state: HotSceneState, prevState: HotSceneState) => void

let mockHotSceneIds: string[] = []
const mockListeners = new Set<Listener>()

vi.mock('../useWorkbenchSceneStore', async () => {
  return {
    useWorkbenchSceneStore: {
      getState: () => ({ hotSceneIds: mockHotSceneIds }),
      subscribe: (listener: Listener) => {
        mockListeners.add(listener)
        return () => mockListeners.delete(listener)
      },
    },
    fromWorkbenchSceneId: (sceneId: string | null | undefined) => {
      if (!sceneId || !sceneId.startsWith('space:')) return null
      return sceneId.slice('space:'.length) || null
    },
  }
})

import {
  installCrawlspaceHotSubscriptionSyncer,
  __resetCrawlspaceHotSubscriptionSyncerForTests,
} from './crawlspaceHotSubscriptionSyncer'

function setHotSceneIds(spaceIds: string[]): void {
  const prev = { hotSceneIds: mockHotSceneIds }
  mockHotSceneIds = spaceIds.map(id => `space:${id}`)
  const next = { hotSceneIds: mockHotSceneIds }
  for (const listener of mockListeners) listener(next, prev)
}

function installSyncer(): void {
  installCrawlspaceHotSubscriptionSyncer(
    () => mockCrawlspaceConfigById as unknown as Record<string, CrawlspaceConfig>,
  )
}

describe('crawlspaceHotSubscriptionSyncer', () => {
  beforeEach(() => {
    __resetCrawlspaceHotSubscriptionSyncerForTests()
    mockRelease.mockClear()
    mockCrawlspaceConfigById = {}
    mockHotSceneIds = []
    mockListeners.clear()
  })

  afterEach(() => {
    __resetCrawlspaceHotSubscriptionSyncerForTests()
  })

  it('hot 集合 push 第 4 个 scene 挤掉旧 scene 时释放被驱逐 spaceId 关联的所有 cs', () => {
    // 场景：用户打开 4 个 Space，A 被驱逐
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
      'cs-b': { crawlspaceId: 'cs-b', spaceId: 'space-b' },
      'cs-c': { crawlspaceId: 'cs-c', spaceId: 'space-c' },
      'cs-d': { crawlspaceId: 'cs-d', spaceId: 'space-d' },
    }
    // 初始 hot = [a, b, c]
    mockHotSceneIds = ['space:space-a', 'space:space-b', 'space:space-c']
    installSyncer()

    // 用户切到 D —— hot 变为 [b, c, d]，A 被驱逐
    setHotSceneIds(['space-b', 'space-c', 'space-d'])

    expect(mockRelease).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledWith('cs-a')
  })

  it('hot 集合内部重排不触发释放（A→B→A 切换）', () => {
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
      'cs-b': { crawlspaceId: 'cs-b', spaceId: 'space-b' },
    }
    mockHotSceneIds = ['space:space-a', 'space:space-b']
    installSyncer()

    // 切到 A（顺序变化但集合不变）
    setHotSceneIds(['space-b', 'space-a'])

    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('一个 spaceId 关联多个 cs（sessionName）—— 驱逐时全部释放', () => {
    mockCrawlspaceConfigById = {
      'cs-a-default': { crawlspaceId: 'cs-a-default', spaceId: 'space-a' },
      'cs-a-session-x': { crawlspaceId: 'cs-a-session-x', spaceId: 'space-a' },
      'cs-b': { crawlspaceId: 'cs-b', spaceId: 'space-b' },
    }
    mockHotSceneIds = ['space:space-a']
    installSyncer()

    // 驱逐 A
    setHotSceneIds(['space-b'])

    expect(mockRelease).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledWith('cs-a-default')
    expect(mockRelease).toHaveBeenCalledWith('cs-a-session-x')
  })

  it('hot 期间动态新增同 spaceId 的 cs（sessionName 启的次级 crawlspace）—— 离开 hot 时所有 cs 都被释放（race 防护）', () => {
    // 这是产品 review 发现的 race bug：syncer 缓存 prev csId set 时，hot 期间
    // 新建的 cs-a2 不会进入 prev，导致 spaceId-A 离开 hot 时 cs-a2 永久泄漏。
    // 修复后：syncer 不缓存 prev，listener 内基于 prevState.hotSceneIds
    // + 最新 config 现算 prev csIds。
    mockCrawlspaceConfigById = {
      'cs-a-default': { crawlspaceId: 'cs-a-default', spaceId: 'space-a' },
    }
    mockHotSceneIds = ['space:space-a']
    installSyncer()

    // hot 期间用户在 spaceId-A 内创建 sessionName workspace，新增 cs-a2
    // 此时 hotSceneIds 没变，listener 不触发——syncer 不感知
    mockCrawlspaceConfigById['cs-a-session-x'] = {
      crawlspaceId: 'cs-a-session-x',
      spaceId: 'space-a',
    }

    // 用户切到 spaceId-B —— hot 变 [b]，A 被驱逐
    mockCrawlspaceConfigById['cs-b'] = { crawlspaceId: 'cs-b', spaceId: 'space-b' }
    setHotSceneIds(['space-b'])

    // 验证：cs-a-default + cs-a-session-x 都被释放
    expect(mockRelease).toHaveBeenCalledTimes(2)
    expect(mockRelease).toHaveBeenCalledWith('cs-a-default')
    expect(mockRelease).toHaveBeenCalledWith('cs-a-session-x')
  })

  it('新 cs 进入 hot 不触发释放（add-only 场景）', () => {
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
      'cs-b': { crawlspaceId: 'cs-b', spaceId: 'space-b' },
    }
    mockHotSceneIds = ['space:space-a']
    installSyncer()

    setHotSceneIds(['space-a', 'space-b'])

    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('hot 中的 spaceId 没有对应 cs 时不报错（仅 chat-only Space 场景）', () => {
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
    }
    mockHotSceneIds = ['space:space-a', 'space:space-b']
    installSyncer()

    // 驱逐 space-b（没 cs）+ space-a 仍 hot
    setHotSceneIds(['space-a'])
    expect(mockRelease).not.toHaveBeenCalled()

    // 驱逐 space-a
    setHotSceneIds(['space-b'])
    expect(mockRelease).toHaveBeenCalledTimes(1)
    expect(mockRelease).toHaveBeenCalledWith('cs-a')
  })

  it('install 后再次调用幂等（不重复 subscribe）', () => {
    installSyncer()
    expect(mockListeners.size).toBe(1)

    installSyncer()
    expect(mockListeners.size).toBe(1)
  })

  it('Space 显式关闭后 hot 集合稍后变化—— 已被 close 释放的 cs 仍冗余调 release（registry 幂等保证）', () => {
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
      'cs-b': { crawlspaceId: 'cs-b', spaceId: 'space-b' },
      'cs-c': { crawlspaceId: 'cs-c', spaceId: 'space-c' },
    }
    mockHotSceneIds = ['space:space-a', 'space:space-b']
    installSyncer()

    // 模拟 closeCrawlspace(cs-a)：crawlspaceConfigById 删除 cs-a。
    // closeCrawlspace 在自己路径里已 release 过 cs-a；syncer 不感知。
    delete mockCrawlspaceConfigById['cs-a']

    // 用户切到 C —— hot 变为 [b, c]，space-a 被驱逐
    setHotSceneIds(['space-b', 'space-c'])

    // 修复后：listener 基于 prevState.hotSceneIds=[a,b] + 最新 config 算 prev：
    //   prevHotSpaceIds = {a, b}, prev csIds = {cs-b}（cs-a 已删 config，不在 prev）
    //   currHotCsIds = {cs-b, cs-c}
    //   diff: 无释放
    // 这是行为差异：缓存 prev csId 时会冗余调 release(cs-a)；现算 prev 不会。
    // 实际效果更准确 —— 已被 close 路径释放过的 cs 不被 syncer 重复触碰。
    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('rehydrate 后首帧 listener：state.hot=prev.hot 时早退，不误 release', () => {
    // 测试 install 后 zustand 可能因为 rehydrate / hydrate 触发首帧 listener，
    // 此时 state.hotSceneIds === prevState.hotSceneIds 引用相同 → 早退。
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
    }
    mockHotSceneIds = ['space:space-a']
    installSyncer()

    // 触发 listener 但 hotSceneIds 引用不变（zustand 在某些 set 路径会广播
    // 即使没变化）
    const prev = { hotSceneIds: mockHotSceneIds }
    const next = { hotSceneIds: mockHotSceneIds }
    for (const listener of mockListeners) listener(next, prev)

    expect(mockRelease).not.toHaveBeenCalled()
  })

  it('configsById 增删但 hotSceneIds 不变时 syncer 不响应（设计契约）', () => {
    // 设计明确：syncer 只监听 hotSceneIds，crawlspaceConfigById 变化不触发
    // listener。new cs 在 hot 期间被 ensureCrawlspaceContextCache 自然订阅；
    // close cs 走 closeCrawlspace 自己的 release 路径；syncer 仅在 hot 真正
    // 变化时基于最新 config 实时算 diff。
    mockCrawlspaceConfigById = {
      'cs-a': { crawlspaceId: 'cs-a', spaceId: 'space-a' },
    }
    mockHotSceneIds = ['space:space-a']
    installSyncer()

    // 任意改 config —— syncer 不感知
    mockCrawlspaceConfigById['cs-x'] = { crawlspaceId: 'cs-x', spaceId: 'space-x' }
    delete mockCrawlspaceConfigById['cs-a']

    expect(mockRelease).not.toHaveBeenCalled()
    expect(mockListeners.size).toBe(1) // listener 只挂一个
  })
})
