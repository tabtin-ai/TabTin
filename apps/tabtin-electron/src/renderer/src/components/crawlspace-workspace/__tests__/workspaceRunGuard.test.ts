/**
 * Wave 3.2：CrawlspaceWorkspace 双条件守卫的黑盒测试。
 *
 * 直接验证「(hot, config) 4 种组合下的输出」——这是 Wave 3.2 产品决策表第 1
 * 条「Run 在 hot Space "切走但仍 hot" 时不结束——只在 Space 被 hot 集合驱逐
 * 或显式关闭时 endRun」的护城河。任何未来改坏闭包逻辑的回归（比如有人去掉
 * config 检查、或反转 hot 检查），这里会失败。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sceneState = {
  hotSceneIds: [] as string[],
}
const crawlState = {
  crawlspaceConfigById: {} as Record<string, { crawlspaceId: string; spaceId?: string }>,
}

vi.mock('@stores/useWorkbenchSceneStore', () => ({
  useWorkbenchSceneStore: {
    getState: () => sceneState,
  },
  toWorkbenchSceneId: (spaceId: string) => `space:${spaceId}` as const,
}))

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: () => crawlState,
  },
}))

import { createWorkspaceRunGuard } from '../workspaceRunGuard'

describe('createWorkspaceRunGuard — 双条件守卫黑盒测试（Wave 3.2 产品决策表第 1 条）', () => {
  beforeEach(() => {
    sceneState.hotSceneIds = []
    crawlState.crawlspaceConfigById = {}
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('hot=true & config=true → true（Activity hidden 应保活）', () => {
    sceneState.hotSceneIds = ['space:space-A']
    crawlState.crawlspaceConfigById = {
      'cs-A': { crawlspaceId: 'cs-A', spaceId: 'space-A' },
    }
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })
    expect(guard()).toBe(true)
  })

  it('hot=true & config=false → false（用户关闭 crawlspace 但 Space 仍 hot 时应 endRun）', () => {
    // 场景：Space-A foreground，用户在内点关闭 crawlspace。closeCrawlspace 删
    // 了 config，hot 集合不变（Space 还活着）。守卫应让 hook 走 endRun，避免
    // useRunManager 误以为还在 hidden 而保活造成泄漏。
    sceneState.hotSceneIds = ['space:space-A']
    crawlState.crawlspaceConfigById = {} // ← config 已被 closeCrawlspace 删除
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })
    expect(guard()).toBe(false)
  })

  it('hot=false & config=true → false（hot LRU 驱逐时应 endRun）', () => {
    // 场景：用户切到第 4 个 Space，hot 集合 slice(-3) 把 space-A 挤出，但
    // crawlspaceConfigById 仍保留 config（hot syncer 只释放 subscription、
    // 不删 config）。守卫看 hot=false → 放手 endRun，符合产品决策。
    sceneState.hotSceneIds = ['space:space-B', 'space:space-C', 'space:space-D']
    crawlState.crawlspaceConfigById = {
      'cs-A': { crawlspaceId: 'cs-A', spaceId: 'space-A' },
    }
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })
    expect(guard()).toBe(false)
  })

  it('hot=false & config=false → false（删 Space 路径，应 endRun）', () => {
    // 场景：onSpaceDeleted → purgeCrawlspaceData 清理两边 + hot 自然驱逐。
    sceneState.hotSceneIds = []
    crawlState.crawlspaceConfigById = {}
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })
    expect(guard()).toBe(false)
  })

  it('spaceId 为空 → false（默认 endRun，不保活）', () => {
    // 历史遗留：crawlspaceConfig 可能没有 spaceId（早期未升级的 config）。
    // 没有 spaceId 就无法判断 hot，按"放手 endRun"兜底。
    sceneState.hotSceneIds = ['space:space-A']
    crawlState.crawlspaceConfigById = {
      'cs-A': { crawlspaceId: 'cs-A' }, // 无 spaceId
    }
    const guard = createWorkspaceRunGuard({ spaceId: null, crawlspaceId: 'cs-A' })
    expect(guard()).toBe(false)
  })

  it('每次调用都读最新 state（不缓存）', () => {
    // 用户场景：闭包在 mount 时创建，cleanup 在多次切换之后才触发——必须读最
    // 新 state，不能用 mount 时快照。
    crawlState.crawlspaceConfigById = {
      'cs-A': { crawlspaceId: 'cs-A', spaceId: 'space-A' },
    }
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })

    sceneState.hotSceneIds = ['space:space-A']
    expect(guard()).toBe(true)

    // 用户切走，space-A 被驱逐
    sceneState.hotSceneIds = ['space:space-B', 'space:space-C', 'space:space-D']
    expect(guard()).toBe(false)

    // 用户又切回让 space-A 回到 hot
    sceneState.hotSceneIds = ['space:space-C', 'space:space-D', 'space:space-A']
    expect(guard()).toBe(true)
  })

  it('store getState 抛异常 → false（兜底"放手 endRun"，避免孤儿 Run 永生）', () => {
    // 即使我们认为 zustand getState 不会抛，未来 selector 改造或第三方 hook
    // 注入可能引入异常路径——守卫要防御性 fail-safe，否则 cleanup 直接抛会
    // 让 hook 进入半状态（既没 endRun 又没清 ref，Run 真泄漏）。
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })

    const original = sceneState.hotSceneIds
    Object.defineProperty(sceneState, 'hotSceneIds', {
      get() {
        throw new Error('simulated store failure')
      },
      configurable: true,
    })

    try {
      expect(guard()).toBe(false)
    } finally {
      Object.defineProperty(sceneState, 'hotSceneIds', {
        value: original,
        writable: true,
        configurable: true,
      })
    }
  })

  it('回归：onSpaceDeleted dirty 异步路径漏洞链断开（必修 1）', () => {
    // 复核漏洞链回放：
    //   1. 用户删 Space-A（有 dirty）→ use-space-store.deleteSpace
    //   2. spaces 立即移除 A
    //   3. bridge.onSpaceDeleted(A) → app-shell-init.onSpaceDeleted
    //   4. dirty 不为空 → saveAllDirty.finally(purgeCrawlspaceData)（异步排队）
    //   5. 同步阶段：SpaceWorkbenchHost 立即不再渲染 A → CrawlspaceWorkspace
    //      unmount → useRunManager cleanup → 调本守卫
    //   6. 此时 saveAllDirty 还没 finally 完成 → config 仍在
    //
    // 修复前：hot 仍含 A（从未剔除）+ config 仍在 → 双条件 true → 错误保活 → Run 泄漏
    // 修复后：onSpaceDeleted 入口同步 removeFromHot → hot 立即不含 A → 双条件
    //         hot=false → 守卫返 false → endRun 跑通
    //
    // 这里直接构造修复后的状态：hot 不含 A（因为 removeFromHot 同步跑了），config
    // 仍在（saveAllDirty.finally 未触发）。守卫必须返 false。
    sceneState.hotSceneIds = ['space:space-B'] // ← removeFromHot('space:space-A') 后只剩 B
    crawlState.crawlspaceConfigById = {
      'cs-A': { crawlspaceId: 'cs-A', spaceId: 'space-A' }, // ← purgeCrawlspaceData 还没跑
    }
    const guard = createWorkspaceRunGuard({ spaceId: 'space-A', crawlspaceId: 'cs-A' })
    expect(guard()).toBe(false)
  })
})
