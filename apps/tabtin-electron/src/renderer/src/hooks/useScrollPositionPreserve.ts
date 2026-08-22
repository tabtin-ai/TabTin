/**
 * useScrollPositionPreserve —— hot-spaces 切换时保留 / 恢复 scroll 位置
 *
 * 本文件同时是 Wave 5 useVirtualizer 治理的**单一事实源**：调用方文件里
 * 不要再复制大段技术原理，直接指过来即可。
 *
 * ## 业务场景
 *
 * 用户在长聊天里滚到第 1000 条消息 → 切到别的 Space → 再切回来 →
 * scroll 应该停在第 1000 条（不是跳回顶部）。
 *
 * `SpaceWorkbenchHost` 用 React 19.2 `<Activity mode="hidden">` 把后台
 * hot Space 子树的 effect 全部 cleanup（**不卸载组件**，state/ref 保留）；
 * 切回 `mode="visible"` 时所有 effect 重新 setup。本 hook 正好搭在这个
 * 调度边界上：cleanup 时保存 scrollTop，setup 时恢复 scrollTop。
 *
 * ## 为什么 useVirtualizer 还要单独 `enabled: isForeground`
 *
 * 仅靠 `<Activity>` 调度（粗粒度 cleanup）不足以避免 React ：
 *
 * 1. `<Activity mode="hidden">` 走的是把整棵子树 DOM `display:none`、
 *    然后 cleanup 所有 effect。但 hidden→visible 切换的过渡帧里
 *    （以及 inactive 子树第一次 mount 但 `mode="hidden"` 的瞬间），
 *    容器 `getBoundingClientRect() = 0×0`。
 * 2. TanStack Virtual 的 `observeElementRect` 通过 `ResizeObserver`
 *    监听容器尺寸；0×0 → 任意尺寸的剧烈变化触发同步 `setState` →
 *    render-phase dispatch → React （issue TanStack/virtual#1067 模式）。
 * 3. `enabled: isForeground` 把 ResizeObserver 整个不挂——这是预先
 *    把"不安全的 effect"从根上掐掉。Activity 是兜底（粗粒度），enabled
 *    gate 是精细化（提前拦截）；两层互补。
 *
 * 未来 TanStack Virtual 修了 ，**只需统一删除 10 处的 `enabled`
 * flag**，本 hook 自身不动——这个解耦就是 Wave 5 的设计点。
 *
 * ## scopeKey：上下文切换时主动重置
 *
 * 当**同一组件实例**被复用承载不同上下文时（例如 `MessageList` 切换
 * `currentSessionId`、`FileTree` 切换 `rootPath`、`DataBrowser` 切换
 * `deviceId`），原本的 saved scrollTop 应该被丢弃——它指向的是另一个
 * 上下文里的位置，恢复到这里只会把用户带到错的地方。
 *
 * 调用方传入 `scopeKey`（业务上下文 ID），key 变化时本 hook 自动 reset
 * `savedScrollTopRef` + `needsRestoreRef`——切换上下文后第一次 cleanup
 * 写入的才是当前上下文的 saved。
 *
 * 设计上**优先**用 scopeKey；次选才是父组件传 React `key` 强制 remount
 * 整组件——后者会丢失整个组件 state（输入框未发送内容、UI 临时状态等），
 * 代价更大。两条路径互补，不冲突。
 *
 * ## 设计选型
 *
 * - **不**接 `enabled` 参数。Activity 调度层已经管控 effect 起停——hook
 *   不需要观测业务语义层的 `isForeground`。这样 hook 也能直接用在非
 *   Activity 子树（modal / 独立页面），unmount→remount 走同一条恢复路径。
 * - **不**用 `setTimeout` / `requestAnimationFrame` 等异步 trick 等数据
 *   加载完成。改用 `useLayoutEffect` 依赖 `totalSize`：virtualizer 每次
 *   measure 推进总高度都同帧再尝试恢复——"渐进式追平"，直到能完整恢复
 *   到 saved 为止。
 * - **clamp 上界用 `el.scrollHeight`，不用调用方传入的 `totalSize`**。
 *   `totalSize` 仅反映 virtualizer 部分高度；如果容器内还有非虚拟化的
 *   sticky header / pinned section / footer / 加载条（如 `ChatVerticalTabs`
 *   的 `ChatSplitGroupCard` + `ChatPinnedSection` 与列表共用 scroll
 *   container），按 `totalSize` clamp 会把 saved 错位地裁掉。`scrollHeight`
 *   是 DOM 真值，覆盖所有可滚动内容。`totalSize` 仍作为 effect 依赖触发
 *   渐进式恢复，但不参与 clamp 计算。
 *
 * ## 边界处理
 *
 * - `scrollElementRef.current` 为 null：no-op
 * - `totalSize <= 0`（virtualizer 还没 measure 出来）：保留
 *   `needsRestoreRef`，等 totalSize 变化再尝试
 * - **渐进式 totalSize 增长**（`enabled: false → true` 切换时
 *   `@tanstack/virtual-core` 会清空 `measurementsCache`，re-enable 后
 *   `totalSize` 从 estimate 渐爬到真实测量值）：每帧都尝试恢复，但只有
 *   实际恢复到 saved 完整值时才清 `needsRestoreRef`。未达到 saved 时
 *   保留标志位，等下一次 measurement 推进继续——保证长列表场景下不会
 *   被"过早 clamp 到第一帧的 estimate totalSize"困住，永久放弃恢复
 * - `savedScrollTop` 越界（数据列表真清空 / 缩短到 saved 之下）：clamp 到
 *   `scrollHeight - clientHeight`；这种情况下 `target < saved`，
 *   `needsRestoreRef` 保持 true 等待数据回填——如果数据真没了（比如切换
 *   session），下一次 cleanup 会用新的 saved 覆盖
 * - `scrollTop` 为 NaN：`Number.isFinite` 守卫，丢弃
 * - **React StrictMode 双跑**：useLayoutEffect 在 mount 阶段会跑两次
 *   （setup → cleanup → setup）。第一次 cleanup 把 `el.scrollTop=0`
 *   写到 saved（对 StrictMode 双跑环境下首次 mount，容器还没滚动过，
 *   是 0；写入合法值不会污染语义）；第二次 setup 看 saved=0 触发恢复
 *   到 0（no-op）。整个流程**幂等**，行为正确，附带的代价仅是 saved
 *   不再是初始 null，但功能上完全等价
 *
 * ## 已知限制（产品决策）
 *
 * 1. **按 px 保存 scrollTop，不按 index 锚点**。在 newest-first 排序的
 *    列表（chat session list / 下载历史 / 浏览历史 / 收件箱 / 媒体相册）
 *    上，hidden 期间数据 prepend 会让恢复的 scrollTop 指向**错位的项目**：
 *    用户切回来虽然滚动条没动，但视野里看到的是别的内容。比"跳回顶部"
 *    温和，但不是终态。Prepend-aware 锚点恢复（保存 visible 区第一项的
 *    `id` + offset，恢复时 `virtualizer.scrollToIndex(idx, { align: 'start' })`
 *    再加 offset）留作未来增强。
 *
 * 2. **MessageList 的 auto-scroll 跟随新消息会覆盖恢复**。如果用户切走
 *    前在底部读最新消息，hidden 期间又有新消息进来，切回时本 hook 把
 *    scrollTop 恢复到原位（接近底部），随后 MessageList 的 effect 检查
 *    `isAtBottomRef + isContentUpdated/isNewMessageAppended` 决定是否
 *    跟随到新末尾。**只有用户切走时确实在底部时才跟随**——读历史中段
 *    切走的用户，切回来仍能保留位置（hook 恢复 + auto-scroll 不触发）。
 *    用户主动**发送**消息时通过 `imperativeHandle` 强制跳底，绕过 isAtBottom
 *    守卫——这是 iMessage / WeChat / Telegram / ChatGPT 的统一约定。
 *
 * 3. **`MAX_HOT_SCENES = 3` 的隐式上界**：A→B→C→D→A 链路里 D 进 hot
 *    会把 A 挤出 → A 整组件 unmount → hook saved 随之销毁 → 切回 A 是
 *    cold 启动，scroll 不会恢复。容量内（A→B→C→A）则正常。
 *
 * @example
 * ```tsx
 * const parentRef = useRef<HTMLDivElement>(null)
 * const virtualizer = useVirtualizer({ ..., enabled: isForeground })
 * useScrollPositionPreserve({
 *   scrollElementRef: parentRef,
 *   totalSize: virtualizer.getTotalSize(),
 *   scopeKey: sessionId,   // 同一 MessageList 实例切 session 时自动 reset
 * })
 * ```
 */

import { useLayoutEffect, useRef, type RefObject } from 'react'

export interface UseScrollPositionPreserveOptions {
  /** 滚动容器 ref（即 virtualizer 的 `getScrollElement()` 返回的元素）。 */
  scrollElementRef: RefObject<HTMLElement | null>
  /**
   * 当前虚拟列表总高度（`virtualizer.getTotalSize()`）。
   *
   * 作为依赖项让恢复 effect 在 measurement 推进时同帧触发。**仅作为
   * effect 触发器**——clamp 上界由本 hook 内部直接读 `el.scrollHeight`
   * 决定（见文件头"clamp 上界用 scrollHeight"段）。
   */
  totalSize: number
  /**
   * 业务上下文 ID（可选）。
   *
   * 当**同一组件实例**被复用承载不同上下文时（如 `MessageList` 切换
   * `currentSessionId` / `FileTree` 切换 `rootPath` / `DataBrowser`
   * 切换 `deviceId`），传入对应的上下文 ID。变化时本 hook 自动 reset
   * `savedScrollTopRef` + `needsRestoreRef`，避免跨上下文 saved 漂移。
   *
   * 不传则 hook 不做主动 reset——unmount/remount 仍能自然清理。
   */
  scopeKey?: string | number | null
}

export function useScrollPositionPreserve({
  scrollElementRef,
  totalSize,
  scopeKey,
}: UseScrollPositionPreserveOptions): void {
  const savedScrollTopRef = useRef<number | null>(null)
  const needsRestoreRef = useRef(false)
  const prevScopeKeyRef = useRef<string | number | null | undefined>(scopeKey)

  // scopeKey 变化时主动 reset，避免跨上下文 saved 漂移。用 useLayoutEffect
  // 在 paint 之前同步执行——保证恢复 effect 看到的是已 reset 的状态。
  useLayoutEffect(() => {
    if (prevScopeKeyRef.current !== scopeKey) {
      savedScrollTopRef.current = null
      needsRestoreRef.current = false
      prevScopeKeyRef.current = scopeKey
    }
  }, [scopeKey])

  useLayoutEffect(() => {
    if (savedScrollTopRef.current != null) {
      needsRestoreRef.current = true
    }

    return () => {
      const el = scrollElementRef.current
      if (!el) return
      const top = el.scrollTop
      // DOM spec 保证 scrollTop 不会是负数，但 element 已被销毁或被人为
      // 污染时可能是 NaN——丢弃，保留之前合法的 saved 值。
      if (Number.isFinite(top)) {
        savedScrollTopRef.current = top
      }
    }
  }, [scrollElementRef])

  useLayoutEffect(() => {
    if (!needsRestoreRef.current) return
    const saved = savedScrollTopRef.current
    if (saved == null) {
      needsRestoreRef.current = false
      return
    }
    if (totalSize <= 0) return
    const el = scrollElementRef.current
    if (!el) return

    // clamp 上界用 DOM 真值 `scrollHeight`，覆盖容器内非虚拟化子节点（sticky
    // header / pinned section / footer / 加载条等）。totalSize 仅作为 effect
    // 触发依赖——它代表 virtualizer 部分高度，不能用作整容器的 clamp 上界。
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const target = Math.min(saved, max)
    el.scrollTop = target

    // 只有真正恢复到 saved 完整值才清标志——否则下次 totalSize 推进
    // 时还能继续追平（应对 enabled false→true 后 measurementsCache
    // 重建期间 totalSize 渐进式增长的场景）。
    if (target >= saved) {
      needsRestoreRef.current = false
    }
  }, [totalSize, scrollElementRef])
}
