import React, { Activity, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { OverlayContainerProvider } from '@tabtin/smartsheet-ui'
import { PortalHostBridge, useStablePortalHost } from '@/utils/portal-host'
import { useSidebarContentPortal } from './SidebarContentPortalContext'
import { useCanvasRailPortal } from './CanvasRailPortalContext'
import { SpaceContextContainer } from '@components/context-space/SpaceContextContainer'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import type { CrawlspaceConfig } from '@stores/useCrawlTabStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { useSpaceContextTabsStore, type ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { EMPTY_CANVAS_GROUPS, findGroupForTabKey } from '@stores/canvasLayout/helpers'
import { parseTabKey } from '@stores/contextTabs/helpers'
import { contextRegistry, type ContextItem } from '@components/context-space/registry'
import { deriveContextVisibleCanvasGroups } from '@components/context-space/utils/contextVisibleCanvasGroups'
import { useWorkbenchLifecycle } from './WorkbenchLifecycleContext'
import { SpaceActivityProvider } from './SpaceActivityContext'
import { fromWorkbenchSceneId, toWorkbenchSceneId, type SpaceSceneActivity } from '@/stores/useWorkbenchSceneStore'
import type { CanvasLayoutGroup } from '@stores/canvasLayout/types'

const CrawlspaceWorkspace = React.lazy(() =>
  import('@components/crawlspace-workspace/CrawlspaceWorkspace').then(m => ({ default: m.CrawlspaceWorkspace }))
)

// ── Component ──

interface SpaceWorkbenchHostProps {
  activeSpaceContext: SpaceContext
  foregroundTabScopeKey?: string | null
  crawlspaceConfigById: Record<string, CrawlspaceConfig>
  workspaceLayerVisible: boolean
  shellCanvasVisible?: boolean
}

function createWorkspaceHost(): HTMLDivElement {
  const host = document.createElement('div')
  host.style.display = 'contents'
  return host
}

function isItemVisibleInSpaceContext(
  item: ContextItemRecord | undefined,
  spaceId: string,
  currentSessionId: string | null,
): boolean {
  if (!item) return true
  const handler = contextRegistry.getHandler(item.type)
  if (!handler?.isVisibleInContext) return true
  return handler.isVisibleInContext(item as ContextItem, { spaceId, currentSessionId })
}

function selectIsContextVisibleCanvasMode(
  spaceGroupsByScope: Record<string, CanvasLayoutGroup[]>,
  activeKeyBySpace: Record<string, string | null>,
  itemsBySpace: Record<string, Record<string, ContextItemRecord>>,
  currentSessionId: string | null,
  spaceId: string,
  tabScopeKey: string,
): boolean {
  const activeTabKey = activeKeyBySpace[tabScopeKey]
  if (!activeTabKey) return false

  const parsed = parseTabKey(activeTabKey)
  if (!parsed || parsed.type === 'home') return false

  const groups = spaceGroupsByScope[tabScopeKey] ?? EMPTY_CANVAS_GROUPS
  const group = findGroupForTabKey(groups, activeTabKey)
  if (!group) return false

  const items = itemsBySpace[tabScopeKey] ?? {}
  const visibleTabKeys: string[] = []
  for (const pane of group.panes) {
    const tabKey = pane.content?.tabKey
    if (!tabKey) continue
    if (isItemVisibleInSpaceContext(items[tabKey], spaceId, currentSessionId)) {
      visibleTabKeys.push(tabKey)
    }
  }
  const { visibleGroups } = deriveContextVisibleCanvasGroups([group], visibleTabKeys)
  return visibleGroups.length > 0
}

/**
 * 多 hot Space 同时挂载的工作台宿主——切换 Space 时不卸载子树（避免 unmount/
 * remount 抖动），但用 React 19.2 的 `<Activity>` 暂停后台 Space 的所有
 * effect / 订阅 / 监听器，避免 zombie 副作用。
 *
 * 两层 Activity 的语义：
 * 1. **外层**：`isForeground`——当前 Space 是不是前台。hot 但非前台时整棵
 *    Space 子树（含 SpaceContextContainer + portal 内的 CrawlspaceWorkspace）
 *    走 cleanup，状态保留以便切回时无闪烁；DOM `display:none`。
 * 2. **内层**（仅当存在 crawlspace）：`workspaceLayerVisible && !isCanvasMode`——
 *    覆盖两类"同 Space 内 CrawlspaceWorkspace 让位"场景：
 *    a) 切到非 tabweb tab（table/terminal/...）时 `workspaceLayerVisible=false`
 *    b) 在 tabweb tab 上启用 canvas group 时 `isCanvasMode=true`
 *       —— PersistentCanvasGroups 接管显示，CrawlspaceWorkspace 子树整棵
 *       cleanup（含 `CrawlspaceWorkspace.tsx` 的 find-toggle/zoom/found-in-page
 *       三处 window 全局监听 + 大 restore effect），不再有 zombie 副作用
 *
 *    BrowserView 由 `useViewDisplay` 在 EmbeddedCrawlView 顶层独立驱动，
 *    通过 `CrawlViewPortalLayer` 的 slotTargets 计算 isActive=false 让主进程
 *    hide（不销毁）—— 跟本组件的 Activity 链路是兄弟独立路径。
 *
 * Wave 3.1/3.2/3.3 已经把"切走但仍 hot"必须保活的副作用（context 订阅 /
 * Run / 跨 Space 关闭事件）提到 store 层 / module-level event bus，所以
 * Activity hidden cleanup 不会误伤这些保活路径——它们不再绑在组件 effect 上。
 *
 * ## 重要：两条 portal 链路在 Activity 子树内/外的差别
 *
 * Crawlspace 整体涉及两条 portal 链路，**只有一条**真正在本 Activity 子树内：
 *
 * 1. ✓ **`CrawlspaceWorkspace` 通过 `workspaceLayerHost`**（本组件内
 *    `createPortal(<CrawlspaceWorkspace />, workspaceLayerHost)`）：
 *    - React 父子关系沿 createPortal 调用方保留——CrawlspaceWorkspace 的
 *      React 父级**就是**这里的内层 Activity（即使 DOM 出口在 SpaceContextArea
 *      下的 StableSlot 内）
 *    - DOM 沿 SpaceContextArea → StableSlot → workspaceLayerHost 也在外层
 *      Activity 子树内
 *    - 结论：本组件的 Activity hidden 时，effect cleanup（沿 React 树）+
 *      `display:none`（沿 DOM 树）**两条路径都覆盖到** CrawlspaceWorkspace
 *
 * 2. ✗ **`EmbeddedCrawlView` 通过 `CrawlViewPortalLayer`**（不在本组件控制下）：
 *    - 在 `ContentAreaPortalHost`（SpaceWorkbenchHost 的**兄弟子树**）下的
 *      CrawlViewPortalLayer 里 `createPortal(<EmbeddedCrawlView />, root)`
 *    - root DOM 通过 appendChild 移到 active slot（CrawlViewPortalHost 在
 *      CrawlspaceWorkspace 的 renderView 输出，确实在本 Activity 子树内）
 *      或 parkingHost（不在本 Activity 子树）
 *    - **但 React 父级是 CrawlViewPortalLayer，不是本 Activity**——所以本
 *      Activity hidden 不会沿 React 树覆盖 EmbeddedCrawlView 的 effect
 *    - 这就是为什么 EmbeddedCrawlView 必须**自己包独立 Activity**（见
 *      EmbeddedCrawlView.tsx line 555）；切走 hot Space 时它的 effect cleanup
 *      靠 CrawlViewPortalLayer 重新计算 isActive=false → 触发自己内部 Activity
 *      hidden 这条独立路径
 *
 * 未来读者请勿假设"所有 crawl 相关 portal 都被本 Activity 覆盖"。
 *
 * ## Wave 6.3：Space 级 OverlayContainer
 *
 * 每个 hot Space 在外层 Activity 子树内提供一个 `<OverlayContainerProvider>`，
 * 容器 ref 是 Space 内最外层的 absolute div。这层 Provider 让 smartsheet-ui
 * 的 Popover / DropdownMenu / Select / ContextMenu / Tooltip / Menu / Dialog /
 * Sheet 等 Radix Portal 封装统一 portal 到当前 Space 容器内——切走 hot Space
 * 时整个容器 `display:none`，所有打开的浮层自动跟随消失，不再残留在 body 上。
 * Provider 之外（DEV tools / 全局对话框 / 应用启动浮层）的浮层仍 portal 到 body，
 * useOverlayContainer() 返回 null 时各 smartsheet-ui 封装会 fallback 到 body。
 *
 * createPortal 的 React Context 沿 React 树继承（不沿 DOM 树）——所以即使
 * CrawlspaceWorkspace 的 DOM 出口是 workspaceLayerHost，它的 useOverlayContainer
 * 仍能拿到本 Provider 提供的容器（React 父链可达）。
 */
export const SpaceWorkbenchHost: React.FC<SpaceWorkbenchHostProps> = ({
  activeSpaceContext,
  foregroundTabScopeKey,
  crawlspaceConfigById,
  workspaceLayerVisible,
  shellCanvasVisible = true,
}) => {
  const spaces = useSpaceStore(state => state.spaces)
  const { hotSceneIds, getActivityForSpace } = useWorkbenchLifecycle()
  const workspaceHostMapRef = useRef<Map<string, HTMLDivElement>>(new Map())

  // canvas-mode 派生：跨 useCanvasLayoutStore.spaceGroups + useSpaceContextTabsStore.activeKeyBySpace
  // 计算每个 hot Space 的 isCanvasMode；变化频率 = 用户操作 canvas group / 切 tab，
  // 都是用户主动行为，跟 SpaceWorkbenchHost 的渲染语义对齐。
  // 详细判定逻辑见 `selectIsCanvasModeForSpace` 注释。
  const spaceGroupsByScope = useCanvasLayoutStore(state => state.spaceGroups)
  const activeKeyBySpace = useSpaceContextTabsStore(state => state.activeKeyBySpace)
  const itemsBySpace = useSpaceContextTabsStore(state => state.itemsBySpace)
  const currentSessionId = useChatStore(state => state.currentSessionId)

  const hotSpaces = useMemo(() => {
    const map = new Map<string, SpaceContext>()
    map.set(activeSpaceContext.id, activeSpaceContext)
    hotSceneIds.forEach(sceneId => {
      const spaceId = fromWorkbenchSceneId(sceneId)
      if (!spaceId || map.has(spaceId)) return
      const space = spaces.find(item => item.id === spaceId)
      if (space) {
        map.set(spaceId, space)
      }
    })
    return Array.from(map.values())
  }, [activeSpaceContext, hotSceneIds, spaces])

  const isCanvasModeBySpace = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const space of hotSpaces) {
      const tabScopeKey = space.id === activeSpaceContext.id
        ? (foregroundTabScopeKey || space.id)
        : space.id
      map.set(space.id, selectIsContextVisibleCanvasMode(
        spaceGroupsByScope,
        activeKeyBySpace,
        itemsBySpace,
        currentSessionId,
        space.id,
        tabScopeKey,
      ))
    }
    return map
  }, [activeKeyBySpace, activeSpaceContext.id, currentSessionId, foregroundTabScopeKey, hotSpaces, itemsBySpace, spaceGroupsByScope])

  useEffect(() => {
    const hotSpaceIdSet = new Set(hotSpaces.map(space => space.id))
    for (const spaceId of workspaceHostMapRef.current.keys()) {
      if (!hotSpaceIdSet.has(spaceId)) {
        workspaceHostMapRef.current.delete(spaceId)
      }
    }
  }, [hotSpaces])

  const crawlspaceIdByCarrierKey = useMemo(() => {
    const map = new Map<string, string>()
    Object.values(crawlspaceConfigById).forEach(config => {
      const carrierKey = config.browserScopeKey ?? config.spaceId
      if (carrierKey) {
        map.set(carrierKey, config.crawlspaceId)
      }
    })
    return map
  }, [crawlspaceConfigById])

  return (
    <div className="flex-1 overflow-hidden min-w-0 flex flex-col w-full relative">
      {hotSpaces.map(space => {
        const sceneId = toWorkbenchSceneId(space.id)
        const activity = getActivityForSpace(space.id)
        const isForeground = activity === 'foreground'
        const tabScopeKey = isForeground ? (foregroundTabScopeKey || space.id) : space.id
        const isCanvasMode = isCanvasModeBySpace.get(space.id) ?? false
        const crawlspaceVisible = workspaceLayerVisible && !isCanvasMode
        const crawlspaceId = crawlspaceIdByCarrierKey.get(tabScopeKey) ?? crawlspaceIdByCarrierKey.get(space.id) ?? null
        const crawlspaceConfig = crawlspaceId ? crawlspaceConfigById[crawlspaceId] : null
        let workspaceLayerHost = workspaceHostMapRef.current.get(space.id)
        if (!workspaceLayerHost) {
          workspaceLayerHost = createWorkspaceHost()
          workspaceHostMapRef.current.set(space.id, workspaceLayerHost)
        }
        return (
          <SpaceWorkbenchScene
            key={sceneId}
            space={space}
            tabScopeKey={tabScopeKey}
            activity={activity}
            isForeground={isForeground}
            crawlspaceVisible={crawlspaceVisible}
            crawlspaceId={crawlspaceId}
            crawlspaceConfig={crawlspaceConfig}
            workspaceLayerHost={workspaceLayerHost}
            shellCanvasVisible={shellCanvasVisible}
          />
        )
      })}
    </div>
  )
}

/**
 * 单个 hot Space 的渲染单元——抽出来以便每个 Space 独立持有 OverlayContainer
 * 的 ref（用 Map 共享会导致跨 Space 串）。
 */
interface SpaceWorkbenchSceneProps {
  space: SpaceContext
  tabScopeKey: string
  activity: SpaceSceneActivity
  isForeground: boolean
  crawlspaceVisible: boolean
  crawlspaceId: string | null
  crawlspaceConfig: CrawlspaceConfig | null
  workspaceLayerHost: HTMLDivElement
  shellCanvasVisible: boolean
}

const SpaceWorkbenchScene: React.FC<SpaceWorkbenchSceneProps> = ({
  space,
  tabScopeKey,
  activity,
  isForeground,
  crawlspaceVisible,
  crawlspaceId,
  crawlspaceConfig,
  workspaceLayerHost,
  shellCanvasVisible,
}) => {
  const overlayContainerRef = useRef<HTMLDivElement>(null)
  const workspaceLayerOverlayRef = useRef<HTMLDivElement>(null)
  // 本 scene 私有的桌面侧栏内容宿主：SpaceContextArea 把侧栏内容 portal 进这个稳定节点，
  // 由下面的 PortalHostBridge（渲染在 <Activity> 之外）按 isForeground 同步挂到全局侧栏槽位。
  // 这样切 Space 时旧 scene 的宿主随即被摘下——不受 Activity hidden 子树延迟重渲染影响，
  // 避免全局侧栏短暂出现两份「置顶/标签」内容。
  const sidebarPortalHost = useStablePortalHost()
  const sidebarContentPortal = useSidebarContentPortal()
  // 本 scene 私有的「右侧收起栏」宿主，机制同左侧栏：由 SpaceContextArea portal 进来，
  // PortalHostBridge 只在前台 + 收起栏启用时挂到 shell 右侧槽位，避免多 hot Space 双份。
  const canvasRailPortalHost = useStablePortalHost()
  const canvasRailPortal = useCanvasRailPortal()
  return (
    <>
      <PortalHostBridge
        host={sidebarPortalHost}
        target={sidebarContentPortal.target}
        active={isForeground && sidebarContentPortal.enabled}
        owner="space-sidebar-bridge"
      />
      <PortalHostBridge
        host={canvasRailPortalHost}
        target={canvasRailPortal.target}
        active={isForeground && canvasRailPortal.enabled}
        owner="space-canvas-rail-bridge"
      />
      <Activity mode={isForeground ? 'visible' : 'hidden'}>
        <SpaceActivityProvider activity={activity}>
          <OverlayContainerProvider containerRef={overlayContainerRef}>
            <div ref={overlayContainerRef} className="absolute inset-0 flex flex-col">
              {crawlspaceId && crawlspaceConfig
                ? createPortal(
                    <Activity mode={crawlspaceVisible ? 'visible' : 'hidden'}>
                      <OverlayContainerProvider containerRef={workspaceLayerOverlayRef}>
                        <div ref={workspaceLayerOverlayRef} className="absolute inset-0">
                          <React.Suspense fallback={null}>
                            <CrawlspaceWorkspace
                              crawlspaceId={crawlspaceId}
                              crawlspaceConfig={crawlspaceConfig}
                              tabScopeKey={tabScopeKey}
                              isActive={isForeground && crawlspaceVisible}
                            />
                          </React.Suspense>
                        </div>
                      </OverlayContainerProvider>
                    </Activity>,
                    workspaceLayerHost,
                  )
                : null}
              <SpaceContextContainer
                space={space}
                tabScopeKey={tabScopeKey}
                crawlspaceId={crawlspaceId}
                workspaceLayerHost={workspaceLayerHost}
                shellCanvasVisible={shellCanvasVisible}
                sidebarPortalHost={sidebarPortalHost}
                canvasRailPortalHost={canvasRailPortalHost}
              />
            </div>
          </OverlayContainerProvider>
        </SpaceActivityProvider>
      </Activity>
    </>
  )
}
