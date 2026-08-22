import { createContext, useContext } from 'react'

/**
 * CanvasRailPortalContext —— 对话模式（chatPosition='middle'）下、右侧 Space 画布被
 * 折叠时，shell 在聊天右侧常驻一条精简「收起栏」（打开的标签 + 应用快捷入口）。
 *
 * 收起栏内容需要 SpaceContextArea 里的标签/动作数据，所以由 SpaceContextArea 渲染、
 * portal 到 shell 提供的 `target`（照抄左侧栏的 SidebarContentPortalContext + scene
 * 私有宿主 + PortalHostBridge 机制）。`expandCanvas` 由 shell 用正确的 workspace
 * scopeKey 实现——收起栏点标签/应用时先展开画布，再执行激活动作。
 */
export interface CanvasRailPortalContextValue {
  /** 仅在「对话模式 + 画布折叠 + 选中真实 Space」时为 true。 */
  enabled: boolean
  target: HTMLElement | null
  /** 把右侧画布从折叠态展开（shell 用当前 workspace scopeKey 落 setCanvasCollapsed）。 */
  expandCanvas: () => void
  /** 可用宽度不足时收起栏只显示图标（随窗口大小自适应，由 shell 用 ResizeObserver 判定）。 */
  iconOnly: boolean
}

const CanvasRailPortalCtx = createContext<CanvasRailPortalContextValue>({
  enabled: false,
  target: null,
  expandCanvas: () => {},
  iconOnly: false,
})
CanvasRailPortalCtx.displayName = 'CanvasRailPortal'

export const CanvasRailPortalProvider = CanvasRailPortalCtx.Provider

export function useCanvasRailPortal(): CanvasRailPortalContextValue {
  return useContext(CanvasRailPortalCtx)
}
