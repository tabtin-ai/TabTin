import React, { useMemo, useEffect, useState, useRef, useCallback } from 'react'
import type {
  SlidePresentation,
  PPTAnimation,
  PPTElement,
  PPTElementLink,
  TurningMode,
  Slide,
} from '../types/slides'
import { useSlideShow, type SlideShowOptions } from '../hooks/useSlideShow'
import {
  normalizeSlideLinkTarget,
  normalizeWebHyperlinkInput,
  parseRichTextHyperlinkHref,
} from '../utils/hyperlink'
import { getBackgroundCssValue } from '../utils/background'
import { keymapManager, KeyboardPriority } from '../utils/keymap-manager'
import { useT } from '../i18n'
import { ZIndex } from '@tabtin/app-shell'
import {
  STAGE_BG,
  TRANSITION_DURATION,
  CURSOR_HIDE_DELAY,
  HINT_DURATION,
} from './slideshow/constants'
import { RANDOM_MODES, getTransitionStyle } from './slideshow/pageTransitions'
import { EndScreen, KeyboardHint, ControlBar } from './slideshow/SlideShowChrome'
import {
  resolveElementAnimation,
  assignCssVars,
  pickPrimaryAnimation,
  pickAttentionAnimation,
} from './slideshow/animationResolver'
import { SlideShowElementContent } from './slideshow/SlideShowElementContent'

const WARNED_MISSING_SLIDE_LINK_TARGETS = new Set<string>()

// ═══════════════════════════════════════════════
// 组件 Props
// ═══════════════════════════════════════════════

interface SlideShowProps {
  presentation: SlidePresentation
  /** 从第几页开始放映（默认 0） */
  startIndex?: number
  /** 放映完全结束回调 */
  onEnd?: () => void
  /** 自定义全屏控制（宿主注入，如 Electron） */
  fullscreenOptions?: SlideShowOptions
}

/**
 * 幻灯片放映组件 — 沉浸式全屏体验
 *
 * 完整放映生命周期：
 * 1. 淡入启动 → 2. 快捷键提示（3.5s 消退） → 3. 放映中（翻页/动画） →
 * 4. 结束画面（黑屏提示） → 5. 淡出退出
 *
 * 交互：
 * - 点击/空格/→ 下一步 | 右键/← 上一步
 * - 鼠标移动 → 显示光标和底部控制栏（3s 闲置后自动隐藏）
 * - ESC 立即退出放映
 */
const SlideShow: React.FC<SlideShowProps> = ({
  presentation,
  startIndex = 0,
  onEnd,
  fullscreenOptions,
}) => {
  const show = useSlideShow(presentation, fullscreenOptions)
  const translate = useT()

  // ── UI 状态 ──
  const [entered, setEntered] = useState(false) // 淡入动画完成
  const [exiting, setExiting] = useState(false) // 正在淡出退出
  const [showHint, setShowHint] = useState(true) // 快捷键提示
  const [cursorVisible, setCursorVisible] = useState(true) // 光标可见
  const [controlBarVisible, setControlBarVisible] = useState(false) // 底部控制栏
  const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // 过渡动画状态
  const [transition, setTransition] = useState<{
    active: boolean
    prevIndex: number
    direction: 'next' | 'prev'
    mode: TurningMode
  } | null>(null)
  const prevIndexRef = useRef(startIndex)

  // ── 启动放映 ──
  useEffect(() => {
    show.startShow(startIndex)
    show.enterFullscreen()
    // 入场动画
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setEntered(true))
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 快捷键提示自动消失 ──
  useEffect(() => {
    const timer = setTimeout(() => setShowHint(false), HINT_DURATION)
    return () => clearTimeout(timer)
  }, [])

  // ── 放映结束处理（含淡出动画） ──
  const handleFullExit = useCallback(() => {
    setExiting(true)
    setTimeout(() => {
      show.endShow()
      onEnd?.()
    }, 350) // 淡出动画时长
  }, [show, onEnd])

  // 当 isPlaying 变为 false（由 endShow 触发），通知上层
  useEffect(() => {
    if (!show.isPlaying && entered && !exiting) {
      onEnd?.()
    }
  }, [show.isPlaying, entered, exiting, onEnd])

  // ── 鼠标自动隐藏 ──
  const resetCursorTimer = useCallback(() => {
    setCursorVisible(true)
    if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current)
    cursorTimerRef.current = setTimeout(() => {
      setCursorVisible(false)
      setControlBarVisible(false)
    }, CURSOR_HIDE_DELAY)
  }, [])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      resetCursorTimer()
      // 鼠标接近底部 → 显示控制栏
      const bottomZone = window.innerHeight - 80
      setControlBarVisible(e.clientY >= bottomZone)
    },
    [resetCursorTimer],
  )

  useEffect(() => {
    return () => {
      if (cursorTimerRef.current) clearTimeout(cursorTimerRef.current)
    }
  }, [])

  // ── 监听翻页触发过渡动画 ──
  useEffect(() => {
    if (!show.isPlaying || show.isEnded) return
    const prevIdx = prevIndexRef.current
    const curIdx = show.currentIndex
    if (prevIdx === curIdx) return

    const prevPage = presentation.pages[prevIdx]
    const curPage = presentation.pages[curIdx]
    const direction = curIdx > prevIdx ? 'next' : 'prev'
    const turningMode =
      (direction === 'next' ? curPage?.turningMode : prevPage?.turningMode) || 'no'

    if (turningMode !== 'no') {
      const resolvedMode =
        turningMode === 'random'
          ? RANDOM_MODES[Math.floor(Math.random() * RANDOM_MODES.length)]
          : turningMode
      setTransition({ active: true, prevIndex: prevIdx, direction, mode: resolvedMode })
      const timer = setTimeout(() => setTransition(null), TRANSITION_DURATION)
      prevIndexRef.current = curIdx
      return () => clearTimeout(timer)
    }

    prevIndexRef.current = curIdx
  }, [show.currentIndex, show.isPlaying, show.isEnded, presentation.pages])

  // ── 键盘/鼠标事件 ──
  useEffect(() => {
    if (!show.isPlaying) return

    const handleKeyDown = (e: KeyboardEvent): boolean | void => {
      // 任意按键隐藏提示
      setShowHint(false)
      resetCursorTimer()

      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'Enter':
        case 'PageDown':
          e.preventDefault()
          show.nextStep()
          return true
        case ' ':
          if (document.activeElement instanceof HTMLMediaElement) return
          e.preventDefault()
          show.nextStep()
          return true
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
        case 'Backspace':
          e.preventDefault()
          show.prevStep()
          return true
        case 'Escape':
          e.preventDefault()
          handleFullExit()
          return true
        case 'Home':
          e.preventDefault()
          show.goToPage(0)
          return true
        case 'End':
          e.preventDefault()
          show.goToPage(show.totalPages - 1)
          return true
      }
    }

    const unregisterKeymap = keymapManager.register(KeyboardPriority.OVERLAY, handleKeyDown)

    const handleClick = (e: MouseEvent) => {
      // 忽略控制栏区域的点击
      const target = e.target as HTMLElement
      if (target.closest('[data-slideshow-controls]')) return
      if (e.button === 0) {
        setShowHint(false)
        show.nextStep()
      }
    }

    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      show.prevStep()
    }

    let touchStartX = 0
    let touchStartY = 0
    let touchStartTime = 0
    const SWIPE_THRESHOLD = 50
    const TAP_MAX_MOVE = 15
    const TAP_MAX_DURATION = 300

    const handleTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const touch = e.touches[0]
      touchStartX = touch.clientX
      touchStartY = touch.clientY
      touchStartTime = Date.now()
    }

    const handleTouchEnd = (e: TouchEvent) => {
      if (e.changedTouches.length !== 1) return
      const touch = e.changedTouches[0]
      const dx = touch.clientX - touchStartX
      const dy = touch.clientY - touchStartY
      const elapsed = Date.now() - touchStartTime

      const target = e.target as HTMLElement
      if (target.closest('[data-slideshow-controls]')) return

      if (Math.abs(dx) > SWIPE_THRESHOLD && Math.abs(dx) > Math.abs(dy)) {
        dx < 0 ? show.nextStep() : show.prevStep()
      } else if (Math.abs(dx) <= TAP_MAX_MOVE && Math.abs(dy) <= TAP_MAX_MOVE && elapsed <= TAP_MAX_DURATION) {
        setShowHint(false)
        show.nextStep()
      }
    }

    window.addEventListener('click', handleClick)
    window.addEventListener('contextmenu', handleContextMenu)
    window.addEventListener('touchstart', handleTouchStart, { passive: true })
    window.addEventListener('touchend', handleTouchEnd)

    return () => {
      unregisterKeymap()
      window.removeEventListener('click', handleClick)
      window.removeEventListener('contextmenu', handleContextMenu)
      window.removeEventListener('touchstart', handleTouchStart)
      window.removeEventListener('touchend', handleTouchEnd)
    }
  }, [show.isPlaying, show, handleFullExit, resetCursorTimer])

  const handleActivateLink = useCallback(
    (link: PPTElementLink) => {
      const target = typeof link.target === 'string' ? link.target.trim() : ''
      if (!target) return

      if (link.type === 'slide') {
        const targetPageIndex = resolveSlideLinkPageIndex(target, presentation.pages)
        if (targetPageIndex !== null) {
          show.goToPage(targetPageIndex)
          return
        }
        const warnKey = target.toLowerCase()
        if (!WARNED_MISSING_SLIDE_LINK_TARGETS.has(warnKey)) {
          WARNED_MISSING_SLIDE_LINK_TARGETS.add(warnKey)
          console.warn(`[slideshow] 未找到超链接目标页面: ${target}`)
        }
        return
      }

      const normalizedTarget = normalizeWebHyperlinkInput(target) || target
      window.open(normalizedTarget, '_blank', 'noopener,noreferrer')
    },
    [presentation.pages, show.goToPage],
  )

  if (!show.isPlaying) return null

  const page = presentation.pages[show.currentIndex]
  const { canvasWidth, canvasHeight } = presentation

  const scaleX = typeof window !== 'undefined' ? window.innerWidth / canvasWidth : 1
  const scaleY = typeof window !== 'undefined' ? window.innerHeight / canvasHeight : 1
  const scale = Math.min(scaleX, scaleY)

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: ZIndex.aboveGlobal,
        background: STAGE_BG,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: cursorVisible ? 'default' : 'none',
        userSelect: 'none',
        perspective: 1200,
        opacity: entered && !exiting ? 1 : 0,
        transition: exiting ? 'opacity 0.35s ease' : 'opacity 0.5s ease',
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* ── 结束画面 ── */}
      {show.isEnded ? (
        <EndScreen onExit={handleFullExit} />
      ) : (
        <>
          {/* 过渡：旧页面 */}
          {transition?.active && (
            <PageContainer
              page={presentation.pages[transition.prevIndex]}
              presentation={presentation}
              show={show}
              onActivateLink={handleActivateLink}
              scale={scale}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              transitionStyle={getTransitionStyle(transition.mode, transition.direction, 'leave')}
            />
          )}

          {/* 当前页面 */}
          {page && (
            <PageContainer
              page={page}
              presentation={presentation}
              show={show}
              onActivateLink={handleActivateLink}
              scale={scale}
              canvasWidth={canvasWidth}
              canvasHeight={canvasHeight}
              transitionStyle={
                transition?.active
                  ? getTransitionStyle(transition.mode, transition.direction, 'enter')
                  : undefined
              }
            />
          )}
        </>
      )}

      {/* ── 快捷键提示（入场时短暂显示） ── */}
      {showHint && !show.isEnded && (
        <KeyboardHint />
      )}

      {/* ── 底部控制栏 ── */}
      {!show.isEnded && (
        <ControlBar
          visible={controlBarVisible && cursorVisible}
          currentIndex={show.currentIndex}
          totalPages={show.totalPages}
          onPrev={() => show.prevStep()}
          onNext={() => show.nextStep()}
          onGoToPage={show.goToPage}
          onExit={handleFullExit}
          t={translate}
        />
      )}

      {/* ── 极简进度条（始终显示） ── */}
      {!show.isEnded && (
        <div
          style={{
            position: 'fixed',
            bottom: 0,
            left: 0,
            right: 0,
            height: 2,
            background: 'rgba(255,255,255,0.06)',
            zIndex: ZIndex.sticky,
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${((show.currentIndex + 1) / show.totalPages) * 100}%`,
              background: 'rgba(255,255,255,0.25)',
              transition: 'width 0.4s ease',
            }}
          />
        </div>
      )}
    </div>
  )
}

function resolveSlideLinkPageIndex(target: string, pages: Slide[]): number | null {
  const normalizedTarget = target.trim()
  if (!normalizedTarget) return null

  const directMatch = pages.findIndex((page) => page.id === normalizedTarget)
  if (directMatch >= 0) return directMatch

  const normalizedSlideTarget = normalizeSlideLinkTarget(normalizedTarget)
  if (!normalizedSlideTarget) return null

  const normalizedMatch = pages.findIndex((page) => page.id === normalizedSlideTarget)
  if (normalizedMatch >= 0) return normalizedMatch

  const indexMatch = normalizedSlideTarget.match(/^page-(\d+)$/i)
  if (!indexMatch) return null

  const oneBasedIndex = Number.parseInt(indexMatch[1], 10)
  if (!Number.isFinite(oneBasedIndex)) return null
  if (oneBasedIndex <= 0 || oneBasedIndex > pages.length) return null
  return oneBasedIndex - 1
}

// ═══════════════════════════════════════════════
// 页面容器（包裹过渡动画）
// ═══════════════════════════════════════════════

interface PageContainerProps {
  page: Slide
  presentation: SlidePresentation
  show: ReturnType<typeof useSlideShow>
  onActivateLink: (link: PPTElementLink) => void
  scale: number
  canvasWidth: number
  canvasHeight: number
  transitionStyle?: React.CSSProperties
}

const PageContainer: React.FC<PageContainerProps> = ({
  page,
  presentation,
  show,
  onActivateLink,
  scale,
  canvasWidth,
  canvasHeight,
  transitionStyle,
}) => {
  return (
    <div
      style={{
        width: canvasWidth,
        height: canvasHeight,
        transform: `scale(${scale})`,
        transformOrigin: 'center center',
        position: 'absolute',
        overflow: 'hidden',
      }}
      data-slideshow-page-layer="scale"
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          background: getBackgroundCssValue(page.background, presentation.theme),
          ...transitionStyle,
        }}
        data-slideshow-page-layer="transition"
      >
        {page.elements.map((el) => (
          <SlideShowElement
            key={el.id}
            element={el}
            visible={show.visibleElementIds.has(el.id)}
            animating={show.activeAnimations.has(el.id)}
            animations={show.activeAnimations.get(el.id)}
            onActivateLink={onActivateLink}
          />
        ))}
      </div>
    </div>
  )
}

// ── 放映中的单个元素 ──

interface SlideShowElementProps {
  element: PPTElement
  visible: boolean
  animating: boolean
  animations?: PPTAnimation[]
  onActivateLink: (link: PPTElementLink) => void
}

const SlideShowElement: React.FC<SlideShowElementProps> = ({
  element,
  visible,
  animating,
  animations,
  onActivateLink,
}) => {
  const isLine = element.type === 'line'
  const isInteractiveMedia = element.type === 'video' || element.type === 'audio'
  const hasElementLink = typeof element.link?.target === 'string' && element.link.target.trim().length > 0
  const supportsRichTextLink = element.type === 'text' || element.type === 'shape' || element.type === 'table'
  const pointerEvents = isInteractiveMedia || hasElementLink || supportsRichTextLink ? 'auto' : 'none'
  const lineHeight = isLine
    ? (() => {
        if (
          typeof element.height === 'number'
          && Number.isFinite(element.height)
          && element.height > 0
        ) {
          return element.height
        }
        return Math.max(1, Math.abs(element.end[1] - element.start[1]))
      })()
    : undefined

  const primaryAnimation = useMemo(() => pickPrimaryAnimation(animations), [animations])
  const attentionAnimation = useMemo(() => pickAttentionAnimation(animations), [animations])

  const primaryAnimStyle = useMemo((): React.CSSProperties => {
    if (!animating || !primaryAnimation) return {}
    const resolved = resolveElementAnimation(primaryAnimation)
    const baseStyle: React.CSSProperties = {
      animationName: resolved.animationName,
      animationDuration: `${primaryAnimation.duration}ms`,
      animationFillMode: 'both',
      animationTimingFunction: resolved.timingFunction || 'ease',
      transformOrigin: resolved.transformOrigin,
      ...(primaryAnimation.delay ? { animationDelay: `${primaryAnimation.delay}ms` } : {}),
    }
    return assignCssVars(baseStyle, resolved.vars)
  }, [animating, primaryAnimation])

  const attentionAnimStyle = useMemo((): React.CSSProperties => {
    if (!animating || !attentionAnimation) return {}
    const resolved = resolveElementAnimation(attentionAnimation)
    const baseStyle: React.CSSProperties = {
      animationName: resolved.animationName,
      animationDuration: `${attentionAnimation.duration}ms`,
      animationFillMode: 'both',
      animationTimingFunction: resolved.timingFunction || 'ease',
      transformOrigin: resolved.transformOrigin,
      ...(attentionAnimation.delay ? { animationDelay: `${attentionAnimation.delay}ms` } : {}),
    }
    return assignCssVars(baseStyle, resolved.vars)
  }, [animating, attentionAnimation])

  // 构建 transform：统一处理翻转 + 旋转（与编辑器 ElementRenderer 一致）
  const elTransform = useMemo((): string | undefined => {
    const parts: string[] = []
    if ('flipH' in element && (element as { flipH?: boolean }).flipH) parts.push('scaleX(-1)')
    if ('flipV' in element && (element as { flipV?: boolean }).flipV) parts.push('scaleY(-1)')
    if ('rotate' in element && (element as { rotate?: number }).rotate) {
      parts.push(`rotate(${(element as { rotate?: number }).rotate}deg)`)
    }
    return parts.length > 0 ? parts.join(' ') : undefined
  }, [element])

  if (!visible && !animating && !primaryAnimation && !attentionAnimation) {
    return null
  }

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null
    const anchor = target?.closest('a[href]') as HTMLAnchorElement | null
    if (anchor) {
      e.preventDefault()
      e.stopPropagation()
      const href = anchor.getAttribute('href') || ''
      const parsedLink = parseRichTextHyperlinkHref(href)
      if (parsedLink) {
        onActivateLink(parsedLink)
      }
      return
    }

    if (hasElementLink && element.link) {
      e.preventDefault()
      e.stopPropagation()
      onActivateLink(element.link)
      return
    }

    if (isInteractiveMedia) {
      e.stopPropagation()
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        left: element.x,
        top: isLine ? element.y : (element as Exclude<PPTElement, { type: 'line' }>).y,
        width: element.width,
        height: isLine ? lineHeight : (element as Exclude<PPTElement, { type: 'line' }>).height,
        opacity: element.opacity,
        transform: elTransform,
        transformOrigin: elTransform ? 'center center' : undefined,
        pointerEvents,
      }}
      data-slideshow-element-id={element.id}
      data-slideshow-element-layer="static"
      data-slideshow-controls={isInteractiveMedia || hasElementLink ? 'true' : undefined}
      onMouseDown={isInteractiveMedia ? (e) => e.stopPropagation() : undefined}
      onClick={pointerEvents === 'auto' ? handleClick : undefined}
    >
      <div
        style={{
          width: '100%',
          height: '100%',
          ...primaryAnimStyle,
        }}
        data-slideshow-element-layer="animation-primary"
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            ...attentionAnimStyle,
          }}
          data-slideshow-element-layer="animation-attention"
        >
          <SlideShowElementContent element={element} />
        </div>
      </div>
    </div>
  )
}

export default SlideShow
