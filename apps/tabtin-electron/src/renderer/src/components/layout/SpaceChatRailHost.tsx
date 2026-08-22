import React, { Activity, useMemo, useRef } from 'react'
import { OverlayContainerProvider } from '@tabtin/smartsheet-ui'
import { ChatSidePanel } from '@components/chat/panel/ChatSidePanel'
import type { SpaceContext } from '@components/context-space/SpaceContextContainer'
import { useSpaceStore } from '@stores/useSpaceStore'
import { fromWorkbenchSceneId } from '@/stores/useWorkbenchSceneStore'
import { useWorkbenchLifecycle } from './WorkbenchLifecycleContext'
import { SpaceActivityProvider } from './SpaceActivityContext'
import type { SpaceSceneActivity } from '@/stores/useWorkbenchSceneStore'

interface SpaceChatRailHostProps {
  activeSpaceContext: SpaceContext
}

/**
 * 多 hot Space 同时挂载的 Chat 侧栏宿主——切换 Space 时不卸载 ChatSidePanel
 * 子树（避免 unmount/remount 抖动），但用 React 19.2 的 `<Activity>` 暂停
 * 后台 Space 的所有 effect / 订阅 / 监听器，避免 zombie 副作用。
 *
 * `<Activity mode="hidden">` 自动：
 * - `display: none` 隐藏 DOM
 * - cleanup 整棵子树的 effect（包括第三方 hook 内的）
 * - 保留 useState / useRef 状态
 * - 子树仍可重渲染响应新 props（低优先级）
 *
 * `SpaceActivityProvider` 仍保留，作为业务语义层——子组件可通过
 * `useSpaceActivity()` 表达「即使 hot 也要保活某个订阅」（用 scope: 'hot'）。
 *
 * Wave 6.3：跟 SpaceWorkbenchHost 对称，每个 hot Space 在外层 Activity 子树内
 * 提供 `<OverlayContainerProvider>`——ChatPanel 内 dev panel / MentionPopover /
 * PresetPickerPopover / LLMSnapshotPanel 等 portal 走当前 Space 容器，切走时
 * 容器 `display:none` 自动隐藏。这条路径专治"右栏布局下多 hot Space 都把
 * dev panel 挂到 body 上重叠"以及"幽灵浮层"残留。
 */
export const SpaceChatRailHost: React.FC<SpaceChatRailHostProps> = ({
  activeSpaceContext,
}) => {
  const spaces = useSpaceStore(state => state.spaces)
  const { hotSceneIds, getActivityForSpace } = useWorkbenchLifecycle()

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

  return (
    <div className="relative h-full w-full">
      {hotSpaces.map(space => {
        const activity = getActivityForSpace(space.id)
        const isForeground = activity === 'foreground'
        return (
          <SpaceChatRailScene
            key={space.id}
            space={space}
            activity={activity}
            isForeground={isForeground}
          />
        )
      })}
    </div>
  )
}

/**
 * 单个 hot Space 的 chat rail 渲染单元——抽出来以便每个 Space 独立持有
 * OverlayContainer 的 ref（用 Map 共享会跨 Space 串）。
 */
interface SpaceChatRailSceneProps {
  space: SpaceContext
  activity: SpaceSceneActivity
  isForeground: boolean
}

const SpaceChatRailScene: React.FC<SpaceChatRailSceneProps> = ({
  space,
  activity,
  isForeground,
}) => {
  const overlayContainerRef = useRef<HTMLDivElement>(null)
  return (
    <Activity mode={isForeground ? 'visible' : 'hidden'}>
      <SpaceActivityProvider activity={activity}>
        <OverlayContainerProvider containerRef={overlayContainerRef}>
          <div ref={overlayContainerRef} className="absolute inset-0 h-full w-full">
            <ChatSidePanel
              spaceContext={space}
              organizationId={space.organization_id}
            />
          </div>
        </OverlayContainerProvider>
      </SpaceActivityProvider>
    </Activity>
  )
}
