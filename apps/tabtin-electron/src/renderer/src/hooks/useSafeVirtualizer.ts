/**
 * useSafeVirtualizer — TanStack Virtual 安全 wrapper
 *
 * ## 治什么
 *
 * `@tanstack/react-virtual` 3.13+ / virtual-core 3.14 在某些挂载时机会触发
 * **React Minified Error **（Maximum update depth exceeded / setState during
 * render-phase）：
 *
 *   observeElementRect:95
 *     → handler:27 同步首次调用
 *     → maybeNotify:17
 *     → notify:282
 *     → onChange:18 (flushSync rerender)
 *     → dispatchReducerAction
 *     → React
 *
 * 触发条件：Virtualizer 首次挂载时，`observeElementRect` 内部
 * `handler(getRect(element))` **同步**调用 handler——这一调链路会同步打到
 * React reducer dispatch。如果当时 React 还在 commit phase（典型场景：被
 * `display:none → display:block` 切换、被 React 19 `<Activity hidden→visible>`
 * 重新激活、Suspense 边界 reveal、tab 切换瞬间），dispatch 就会找不到合法的
 * fiber root → 抛 。
 *
 * 上游 issue：
 *   - https://github.com/TanStack/virtual/issues/1067
 *   - https://github.com/TanStack/virtual/issues/499
 *
 * 我们项目里 `SpaceChatRailHost` 用 hot-spaces + `<Activity>` 模式同时挂载
 * 多个 Space 的 ChatPanel，切换时几乎必然踩这个雷。`enabled: isForeground`
 * 双保险只能延迟触发时机不能根治——切回的瞬间 enabled false→true 仍同样炸。
 *
 * ## 怎么治
 *
 * 把 `observeElementRect` 改成自定义实现：所有 cb 调用都用
 * `requestAnimationFrame` 推迟到下一帧，避开 commit phase 的 setState 限制。
 * 这是 GitHub issue 评论里官方推荐的 workaround。
 *
 * ## 用法
 *
 * 把 `useVirtualizer` 改成 `useSafeVirtualizer` 即可，签名 100% 兼容。
 * 不要直接传 `observeElementRect` 选项——那会覆盖我们的安全实现。
 *
 * ## 性能影响
 *
 * RAF 推迟意味着尺寸更新比同步晚 ~16ms 显示。对消息列表 / 文件树这类滚动
 * 容器无感知；对实时尺寸跟踪要求 sub-frame 级别的场景（实际不存在）才有
 * 影响。
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import type { VirtualizerOptions, Virtualizer } from '@tanstack/react-virtual'

/**
 * RAF-safe 版 observeElementRect：所有 cb 调用走下一帧。
 *
 * 与 TanStack Virtual 默认实现的差异：
 * - 默认实现首次同步调 handler(getRect(element))
 * - 本实现首次也走 RAF，避开 render-phase setState
 * - ResizeObserver 回调同样走 RAF（dedup 多个 entry，单帧只调一次）
 *
 * 用 generic function 而不是 const arrow——这样 TS 能在每次调用点正确推断
 * 出 `<TScrollElement, TItemElement>`，跟 useVirtualizer 的泛型链对齐，避免
 * 强转 Virtualizer<Element, Element> ↔ Virtualizer<TScrollElement, TItemElement>
 * 时的 variance 报错。
 */
function rafObserveElementRect<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  instance: Virtualizer<TScrollElement, TItemElement>,
  cb: (rect: { width: number; height: number }) => void,
): void | (() => void) {
  const targetWindow = instance.targetWindow ?? (typeof window !== 'undefined' ? window : null)
  if (!targetWindow) return

  let frameId: number | null = null
  let attachFrameId: number | null = null
  let pendingRect: { width: number; height: number } | null = null
  let observer: ResizeObserver | null = null
  let disposed = false

  const schedule = (rect: { width: number; height: number }): void => {
    if (disposed) return
    pendingRect = rect
    if (frameId != null) return
    frameId = targetWindow.requestAnimationFrame(() => {
      frameId = null
      const next = pendingRect
      pendingRect = null
      if (next) {
        cb({ width: Math.round(next.width), height: Math.round(next.height) })
      }
    })
  }

  const attach = (): void => {
    if (disposed) return
    const element = instance.scrollElement
    if (!element) {
      attachFrameId = targetWindow.requestAnimationFrame(attach)
      return
    }

    // 首次量也走 RAF——这正是治  的关键，避开同步 dispatch。
    const initialRect = element.getBoundingClientRect()
    schedule({ width: initialRect.width, height: initialRect.height })

    if (typeof targetWindow.ResizeObserver === 'undefined') return

    observer = new targetWindow.ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      let width: number
      let height: number
      if (entry.borderBoxSize) {
        const box = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize
        width = box.inlineSize
        height = box.blockSize
      } else {
        width = entry.contentRect.width
        height = entry.contentRect.height
      }
      schedule({ width, height })
    })
    observer.observe(element)
  }

  attach()

  return () => {
    disposed = true
    if (frameId != null) {
      targetWindow.cancelAnimationFrame(frameId)
      frameId = null
    }
    if (attachFrameId != null) {
      targetWindow.cancelAnimationFrame(attachFrameId)
      attachFrameId = null
    }
    observer?.disconnect()
    observer = null
  }
}

/**
 * 让某几个 key 变可选（其余保持原有 required/optional 语义）——跟 TanStack
 * 自己用的 `PartialKeys` 完全等价。useVirtualizer 实际签名把
 * `observeElementRect | observeElementOffset | scrollToFn` 三个标成可选
 * （TanStack 内部会填默认），我们的 wrapper 只覆盖 observeElementRect，
 * 另外两个仍透传给 useVirtualizer 走 TanStack 默认实现。
 */
type PartialKeys<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

/**
 * useVirtualizer 的安全 wrapper——签名完全兼容，自动注入 RAF-safe
 * `observeElementRect`。
 *
 * 调用方**不要**自己传 observeElementRect 选项——会被静默忽略（避免无意中
 * 关掉安全保护）。如果有特殊需求，先去 hot-spaces 治理 issue 讨论。
 */
export function useSafeVirtualizer<
  TScrollElement extends Element,
  TItemElement extends Element,
>(
  options: PartialKeys<
    VirtualizerOptions<TScrollElement, TItemElement>,
    'observeElementOffset' | 'scrollToFn' | 'observeElementRect'
  >,
): Virtualizer<TScrollElement, TItemElement> {
  return useVirtualizer<TScrollElement, TItemElement>({
    ...options,
    observeElementRect: rafObserveElementRect<TScrollElement, TItemElement>,
  })
}
