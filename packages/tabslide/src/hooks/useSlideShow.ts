import { useState, useCallback, useRef, useEffect } from 'react'
import type { SlidePresentation, PPTAnimation } from '../types/slides'

/**
 * 放映模式控制器
 *
 * 动画执行模型：
 * 1. 每页有一个 animations[] 数组
 * 2. animationIndex 追踪当前执行到哪个动画
 * 3. click 触发下一个动画（或下一页）
 * 4. meantime 类型与上一个动画同时执行
 * 5. auto 类型在上一个结束后自动执行
 * 6. 页面的所有动画执行完后，下一次 click 跳转下一页
 * 7. 最后一页播完 → 进入 isEnded 状态（显示结束画面），再点击 → 完全退出
 */

export interface SlideShowState {
  /** 是否正在放映（包含结束画面阶段） */
  isPlaying: boolean
  /** 放映已到达最后一页末尾（显示结束画面） */
  isEnded: boolean
  /** 当前页索引 */
  currentIndex: number
  /** 当前页的动画执行进度（-1 = 全部动画还没开始） */
  animationIndex: number
  /** 当前正在执行动画的元素 ID 集合 */
  animatedElementIds: Set<string>
  /** 当前正在执行动画（按元素聚合，值为该元素当前激活动画队列） */
  activeAnimations: Map<string, PPTAnimation[]>
  /** 已排队等待自动触发的动画起始索引 */
  pendingAutoIndex: number | null
  /** 已完成入场动画的元素 ID 集合（可见） */
  visibleElementIds: Set<string>
}

export interface SlideShowOptions {
  /** 自定义进入全屏（宿主层注入，如 Electron setFullScreen） */
  onEnterFullscreen?: () => void
  /** 自定义退出全屏 */
  onExitFullscreen?: () => void
}

export function useSlideShow(
  presentation: SlidePresentation | null,
  options?: SlideShowOptions,
) {
  const [state, setState] = useState<SlideShowState>({
    isPlaying: false,
    isEnded: false,
    currentIndex: 0,
    animationIndex: -1,
    animatedElementIds: new Set(),
    activeAnimations: new Map<string, PPTAnimation[]>(),
    pendingAutoIndex: null,
    visibleElementIds: new Set(),
  })

  const stateRef = useRef(state)
  stateRef.current = state
  const optionsRef = useRef(options)
  optionsRef.current = options

  const totalPages = presentation?.pages.length ?? 0
  const timerIdsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  const runtimeTokenRef = useRef(0)

  const clearTimers = useCallback(() => {
    for (const timerId of timerIdsRef.current) {
      clearTimeout(timerId)
    }
    timerIdsRef.current.clear()
  }, [])

  const invalidateRuntime = useCallback(() => {
    runtimeTokenRef.current += 1
    clearTimers()
  }, [clearTimers])

  const scheduleTimer = useCallback((callback: () => void, delayMs: number) => {
    const delay = Number.isFinite(delayMs) ? Math.max(0, delayMs) : 0
    const timerId = setTimeout(() => {
      timerIdsRef.current.delete(timerId)
      callback()
    }, delay)
    timerIdsRef.current.add(timerId)
  }, [])

  useEffect(() => {
    return () => {
      clearTimers()
    }
  }, [clearTimers])

  // ── 获取当前页的动画列表 ──
  const getPageAnimations = useCallback((pageIndex: number): PPTAnimation[] => {
    if (!presentation) return []
    return presentation.pages[pageIndex]?.animations ?? []
  }, [presentation])

  const getCurrentAnimations = useCallback((): PPTAnimation[] => {
    return getPageAnimations(stateRef.current.currentIndex)
  }, [getPageAnimations])

  const isElementRenderable = useCallback(
    (pageIndex: number, elId: string) => {
      if (!presentation) return false
      const page = presentation.pages[pageIndex]
      if (!page) return false
      const element = page.elements.find((el) => el.id === elId)
      return element?.visible !== false
    },
    [presentation],
  )

  // ── 初始化页面可见性 ──
  const initPageVisibility = useCallback(
    (pageIndex: number) => {
      if (!presentation) return new Set<string>()
      const page = presentation.pages[pageIndex]
      if (!page) return new Set<string>()

      const animations = page.animations ?? []
      const hasEnterAnimation = new Set<string>()
      for (const anim of animations) {
        if (anim.type === 'in') {
          hasEnterAnimation.add(anim.elId)
        }
      }

      const visible = new Set<string>()
      for (const el of page.elements) {
        if (el.visible === false) continue
        if (!hasEnterAnimation.has(el.id)) {
          visible.add(el.id)
        }
      }
      return visible
    },
    [presentation],
  )

  const buildVisibilityUntilIndex = useCallback(
    (pageIndex: number, animationEndIndex: number) => {
      const visible = initPageVisibility(pageIndex)
      if (!presentation || animationEndIndex < 0) return visible

      const animations = getPageAnimations(pageIndex)
      const end = Math.min(animationEndIndex, animations.length - 1)
      for (let i = 0; i <= end; i += 1) {
        const anim = animations[i]
        if (!anim) continue
        if (anim.type === 'in') {
          if (isElementRenderable(pageIndex, anim.elId)) {
            visible.add(anim.elId)
          }
          continue
        }
        if (anim.type === 'out') {
          visible.delete(anim.elId)
        }
      }
      return visible
    },
    [initPageVisibility, presentation, getPageAnimations, isElementRenderable],
  )

  const getGroupStartIndex = useCallback((animations: PPTAnimation[], index: number) => {
    if (index <= 0) return 0
    let start = Math.min(index, animations.length - 1)
    while (start > 0 && animations[start]?.trigger === 'meantime') {
      start -= 1
    }
    return start
  }, [])

  const getGroupEndIndex = useCallback((animations: PPTAnimation[], startIndex: number) => {
    if (animations.length === 0) return -1
    let end = Math.max(0, Math.min(startIndex, animations.length - 1))
    while (end + 1 < animations.length && animations[end + 1]?.trigger === 'meantime') {
      end += 1
    }
    return end
  }, [])

  // ── 全屏控制 ──
  const enterFullscreen = useCallback(() => {
    if (optionsRef.current?.onEnterFullscreen) {
      optionsRef.current.onEnterFullscreen()
    } else {
      document.documentElement.requestFullscreen?.()
    }
  }, [])

  const exitFullscreen = useCallback(() => {
    if (optionsRef.current?.onExitFullscreen) {
      optionsRef.current.onExitFullscreen()
    } else {
      document.exitFullscreen?.()
    }
  }, [])

  // ── 开始放映 ──
  const startShow = useCallback(
    (fromIndex = 0) => {
      if (!presentation || totalPages === 0) return
      invalidateRuntime()
      const visible = initPageVisibility(fromIndex)
      setState({
        isPlaying: true,
        isEnded: false,
        currentIndex: fromIndex,
        animationIndex: -1,
        animatedElementIds: new Set(),
        activeAnimations: new Map<string, PPTAnimation[]>(),
        pendingAutoIndex: null,
        visibleElementIds: visible,
      })
    },
    [presentation, totalPages, initPageVisibility, invalidateRuntime],
  )

  // ── 结束放映（完全退出） ──
  const endShow = useCallback(() => {
    invalidateRuntime()
    exitFullscreen()
    setState((s) => ({
      ...s,
      isPlaying: false,
      isEnded: false,
      animatedElementIds: new Set(),
      activeAnimations: new Map<string, PPTAnimation[]>(),
      pendingAutoIndex: null,
    }))
  }, [exitFullscreen, invalidateRuntime])

  // ── 进入结束画面 ──
  const showEndScreen = useCallback(() => {
    invalidateRuntime()
    setState((s) => ({
      ...s,
      isEnded: true,
      animatedElementIds: new Set(),
      activeAnimations: new Map<string, PPTAnimation[]>(),
      pendingAutoIndex: null,
    }))
  }, [invalidateRuntime])

  const runAnimationBatch = useCallback((pageIndex: number, startIndex: number) => {
    if (!presentation) return
    const animations = getPageAnimations(pageIndex)
    if (animations.length === 0 || startIndex < 0 || startIndex >= animations.length) return

    const batchStart = getGroupStartIndex(animations, startIndex)
    const batchEnd = getGroupEndIndex(animations, batchStart)
    if (batchEnd < batchStart) return

    const batch = animations.slice(batchStart, batchEnd + 1)
    const initialVisible =
      stateRef.current.currentIndex === pageIndex
        ? new Set(stateRef.current.visibleElementIds)
        : new Set<string>()
    const effectiveBatch: PPTAnimation[] = []
    const stagedVisible = new Set(initialVisible)
    for (const anim of batch) {
      if (!isElementRenderable(pageIndex, anim.elId)) continue
      const canRun =
        anim.type === 'in'
          ? true
          : stagedVisible.has(anim.elId)
      if (!canRun) continue
      effectiveBatch.push(anim)
      if (anim.type === 'in') {
        stagedVisible.add(anim.elId)
      }
    }
    const runtimeToken = runtimeTokenRef.current
    const nextAutoIndex = batchEnd + 1
    const hasQueuedAuto =
      nextAutoIndex < animations.length && animations[nextAutoIndex]?.trigger === 'auto'

    setState((prev) => {
      if (!prev.isPlaying || prev.currentIndex !== pageIndex) return prev
      const nextAnimated = new Set(prev.animatedElementIds)
      const nextVisible = new Set(prev.visibleElementIds)
      const nextActiveAnimations = new Map(prev.activeAnimations)

      for (const anim of effectiveBatch) {
        nextAnimated.add(anim.elId)
        const queue = nextActiveAnimations.get(anim.elId) ?? []
        nextActiveAnimations.set(anim.elId, [...queue, anim])
        if (anim.type === 'in') {
          nextVisible.add(anim.elId)
        }
      }

      return {
        ...prev,
        animationIndex: batchEnd,
        animatedElementIds: nextAnimated,
        activeAnimations: nextActiveAnimations,
        pendingAutoIndex: hasQueuedAuto ? nextAutoIndex : null,
        visibleElementIds: nextVisible,
      }
    })

    let maxDuration = 0
    for (const anim of effectiveBatch) {
      const duration = Number.isFinite(anim.duration) ? Math.max(0, anim.duration) : 0
      maxDuration = Math.max(maxDuration, duration)
      scheduleTimer(() => {
        if (runtimeTokenRef.current !== runtimeToken) return
        setState((prev) => {
          if (!prev.isPlaying || prev.currentIndex !== pageIndex) return prev

          const nextAnimated = new Set(prev.animatedElementIds)
          const nextActiveAnimations = new Map(prev.activeAnimations)
          const currentQueue = nextActiveAnimations.get(anim.elId)
          if (currentQueue?.length) {
            const nextQueue = currentQueue.filter((item) => item.id !== anim.id)
            if (nextQueue.length > 0) {
              nextActiveAnimations.set(anim.elId, nextQueue)
            } else {
              nextActiveAnimations.delete(anim.elId)
              nextAnimated.delete(anim.elId)
            }
          } else {
            nextAnimated.delete(anim.elId)
          }

          let nextVisible = prev.visibleElementIds
          if (anim.type === 'out') {
            nextVisible = new Set(prev.visibleElementIds)
            nextVisible.delete(anim.elId)
          }

          return {
            ...prev,
            animatedElementIds: nextAnimated,
            activeAnimations: nextActiveAnimations,
            visibleElementIds: nextVisible,
          }
        })
      }, duration)
    }

    if (hasQueuedAuto) {
      scheduleTimer(() => {
        if (runtimeTokenRef.current !== runtimeToken) return
        setState((prev) => {
          if (!prev.isPlaying || prev.currentIndex !== pageIndex) return prev
          return { ...prev, pendingAutoIndex: null }
        })
        runAnimationBatch(pageIndex, nextAutoIndex)
      }, maxDuration)
    }
  }, [
    presentation,
    getPageAnimations,
    getGroupStartIndex,
    getGroupEndIndex,
    scheduleTimer,
    isElementRenderable,
  ])

  useEffect(() => {
    if (!state.isPlaying || state.isEnded) return
    if (state.animationIndex !== -1) return
    if (state.animatedElementIds.size > 0) return
    if (state.pendingAutoIndex !== null) return
    const animations = getPageAnimations(state.currentIndex)
    if (animations.length === 0) return
    if (animations[0]?.trigger !== 'auto') return
    runAnimationBatch(state.currentIndex, 0)
  }, [
    state.isPlaying,
    state.isEnded,
    state.currentIndex,
    state.animationIndex,
    state.animatedElementIds,
    state.pendingAutoIndex,
    getPageAnimations,
    runAnimationBatch,
  ])

  // ── 翻页 ──
  const nextPage = useCallback(() => {
    const s = stateRef.current
    if (!s.isPlaying || !presentation) return
    if (s.currentIndex >= totalPages - 1) {
      showEndScreen()
      return
    }

    invalidateRuntime()
    const newIndex = s.currentIndex + 1
    const visible = initPageVisibility(newIndex)
    setState((prev) => ({
      ...prev,
      currentIndex: newIndex,
      animationIndex: -1,
      animatedElementIds: new Set(),
      activeAnimations: new Map<string, PPTAnimation[]>(),
      pendingAutoIndex: null,
      visibleElementIds: visible,
    }))
  }, [presentation, totalPages, showEndScreen, initPageVisibility, invalidateRuntime])

  const prevPage = useCallback(() => {
    const s = stateRef.current
    if (!s.isPlaying || !presentation) return

    // 从结束画面返回最后一页
    if (s.isEnded) {
      setState((prev) => ({ ...prev, isEnded: false }))
      return
    }

    if (s.currentIndex <= 0) return

    invalidateRuntime()
    const newIndex = s.currentIndex - 1
    const visible = initPageVisibility(newIndex)
    setState((prev) => ({
      ...prev,
      currentIndex: newIndex,
      animationIndex: -1,
      animatedElementIds: new Set(),
      activeAnimations: new Map<string, PPTAnimation[]>(),
      pendingAutoIndex: null,
      visibleElementIds: visible,
    }))
  }, [presentation, initPageVisibility, invalidateRuntime])

  // ── 执行下一步（点击/空格触发） ──
  const nextStep = useCallback(() => {
    const s = stateRef.current
    if (!s.isPlaying || !presentation) return

    // 结束画面 → 退出放映
    if (s.isEnded) {
      endShow()
      return
    }

    if (s.animatedElementIds.size > 0) return
    if (s.pendingAutoIndex !== null) return

    const animations = getCurrentAnimations()
    const nextAnimIdx = s.animationIndex + 1

    if (nextAnimIdx < animations.length) {
      runAnimationBatch(s.currentIndex, nextAnimIdx)
    } else {
      nextPage()
    }
  }, [presentation, getCurrentAnimations, endShow, nextPage, runAnimationBatch])

  // ── 上一步 ──
  const prevStep = useCallback(() => {
    const s = stateRef.current
    if (!s.isPlaying || !presentation) return

    // 结束画面 → 返回最后一页
    if (s.isEnded) {
      setState((prev) => ({ ...prev, isEnded: false }))
      return
    }

    if (s.animationIndex >= 0) {
      const animations = getCurrentAnimations()
      const currentGroupStart = getGroupStartIndex(animations, s.animationIndex)
      const targetAnimationIndex = currentGroupStart - 1
      invalidateRuntime()
      const visible = buildVisibilityUntilIndex(s.currentIndex, targetAnimationIndex)
      setState((prev) => ({
        ...prev,
        animationIndex: targetAnimationIndex,
        animatedElementIds: new Set(),
        activeAnimations: new Map<string, PPTAnimation[]>(),
        pendingAutoIndex: null,
        visibleElementIds: visible,
      }))
    } else {
      prevPage()
    }
  }, [
    presentation,
    getCurrentAnimations,
    getGroupStartIndex,
    buildVisibilityUntilIndex,
    invalidateRuntime,
    prevPage,
  ])

  const goToPage = useCallback(
    (index: number) => {
      const s = stateRef.current
      if (!s.isPlaying || !presentation) return
      if (index < 0 || index >= totalPages) return
      invalidateRuntime()
      const visible = initPageVisibility(index)
      setState((prev) => ({
        ...prev,
        isEnded: false,
        currentIndex: index,
        animationIndex: -1,
        animatedElementIds: new Set(),
        activeAnimations: new Map<string, PPTAnimation[]>(),
        pendingAutoIndex: null,
        visibleElementIds: visible,
      }))
    },
    [presentation, totalPages, initPageVisibility, invalidateRuntime],
  )

  // ── 键盘/鼠标事件（不再在 hook 内绑定，由 SlideShow 组件统一管理） ──

  return {
    ...state,
    totalPages,
    startShow,
    endShow,
    nextStep,
    prevStep,
    nextPage,
    prevPage,
    goToPage,
    enterFullscreen,
    exitFullscreen,
  }
}
