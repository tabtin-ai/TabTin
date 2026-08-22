/**
 * OverlayContainerContext
 *
 * 为多标签布局提供 overlay（Dialog / Sheet）的渲染容器。
 *
 * 默认情况下 Radix Dialog/Sheet 通过 Portal 渲染到 document.body，
 * 这在多标签页架构中会导致弹框/抽屉脱离所属标签页，
 * 在标签切换时仍然可见，违反标签隔离原则。
 *
 * 使用方式：
 * 1. 在标签页容器外层提供 Provider:
 *    <OverlayContainerProvider containerRef={myRef}>
 *      <div ref={myRef} className="relative overflow-hidden ...">
 *        ...pane content...
 *      </div>
 *    </OverlayContainerProvider>
 *
 * 2. 所有 DialogContent / SheetContent 会自动消费此 context，
 *    将 Portal 渲染到容器内，并使用 absolute 定位替代 fixed。
 *
 * 3. 未包裹 Provider 时，降级到原有行为（Portal 到 body + fixed 定位）。
 */

import * as React from 'react'

export interface OverlayContainerContextValue {
  /** overlay 应渲染到的 DOM 容器元素 */
  container: HTMLElement | null
}

const OverlayContainerContext = React.createContext<OverlayContainerContextValue>({
  container: null,
})

export interface OverlayContainerProviderProps {
  /** 容器 ref，overlay 将 portal 到此元素内部 */
  containerRef: React.RefObject<HTMLElement | null>
  children: React.ReactNode
}

export const OverlayContainerProvider: React.FC<OverlayContainerProviderProps> = ({
  containerRef,
  children,
}) => {
  // 用 state 持有实际 DOM 元素，以便在 mount 后触发 re-render。
  //
  // 注意：不要在 useLayoutEffect 里同步 setContainer(containerRef.current)。
  // React 19 <Activity mode="hidden"→"visible"> 恢复子树时会重新 mount layout
  // effects；如果此处同步 setState，React 仍在 commit/layout effect 阶段，容易触发
  // Minified React error （Maximum update depth exceeded）。这和 TanStack Virtual
  // observeElementRect / Radix Presence 同步 dispatch 是同一类问题。
  //
  // 用 requestAnimationFrame 推迟到下一帧，避开 commit phase；cleanup cancel 则防止
  // Provider 在帧到来前被隐藏/卸载时误更新。
  const [container, setContainer] = React.useState<HTMLElement | null>(null)

  React.useLayoutEffect(() => {
    const frameId = requestAnimationFrame(() => {
      setContainer(containerRef.current)
    })
    return () => cancelAnimationFrame(frameId)
  }, [containerRef])

  const value = React.useMemo(() => ({ container }), [container])

  return (
    <OverlayContainerContext.Provider value={value}>
      {children}
    </OverlayContainerContext.Provider>
  )
}

/**
 * 获取 overlay 容器元素。
 * 返回 null 时表示未在 Provider 内部，应降级到默认行为。
 */
export function useOverlayContainer(): HTMLElement | null {
  const { container } = React.useContext(OverlayContainerContext)
  return container
}

export { OverlayContainerContext }
