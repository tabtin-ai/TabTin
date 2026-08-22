/**
 * NormalTab —— 单个普通标签的渲染组件
 *
 * 职责：
 *   - 渲染 tab 视觉（图标 + 标题 + 关闭按钮 + 颜色背景）
 *   - 关闭动画 className（max-width / opacity / padding 收缩）
 *   - tabdoc dirty 指示符（小圆点 + 颜色随 saveState 变化）
 *   - 中键关闭 / 拖拽重排 / 右键菜单代理
 *
 * 不负责：
 *   - 决定何时进入 closing 状态（由 useCloseAnimation）
 *   - 维护 dirty 订阅（由 useTabDocDirtyIndicator）
 *   - 计算颜色（由 colorLuminance utils）
 *
 * 关闭动画依赖几个关键 className：
 *   - 默认：min-w-[48px] max-w-[220px] shrink-0；可关闭标签右侧为 X 预留空间
 *   - closing：!max-w-0 !min-w-0 !px-0 opacity-0 pointer-events-none
 *   - transition：transition-all [transition-duration:120ms] ease-out
 *   元素 children（图标/文字/关闭按钮）也需要 transition 以避免突变
 */
import React, { forwardRef } from 'react'
import type { TFunction } from 'i18next'
import { Expand, Loader2, Moon, Shrink, X } from 'lucide-react'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT } from '@components/layout/canvasUi'
import { captureTaskViewModeMorph } from '@components/chat/capsule/chatCapsuleMorph'
import { isIsolatedScopeKey } from '@components/layout/workspaceContextState'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import { useOptionalSpaceContextState } from '@components/context-space/SpaceContextAreaContext'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useUIStore } from '@stores/useUIStore'
import type { TabDragProps } from '@hooks/useTabReorder'
import { useTabDocDirtyIndicator } from './hooks/useTabDocDirtyIndicator'
import { DirtyIndicator } from './DirtyIndicator'

/**
 * 关闭按钮的 className —— hover 才显示；浅灰底融入选中标签，避免白块过重。
 */
export const CLOSE_BTN_CLASS =
  'bg-foreground/[0.04] dark:bg-foreground/[0.06] text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] dark:hover:bg-foreground/[0.10]'

/** ContextTabs 子组件共享的 i18n 翻译函数类型（"context" namespace） */
export type ContextTabsT = TFunction<'context'>

/** Tailwind 基线类，与原 ContextTabs.baseTabClass 完全等价（拆分前的视觉契约） */
export const NORMAL_TAB_BASE_CLASS =
  `group relative flex items-center gap-1 h-7 py-1 rounded-interactive ${CANVAS_TAB_TEXT} cursor-pointer min-w-[48px] max-w-[220px] shrink-0 overflow-hidden border border-transparent box-border`

/** 选中态：灰底圆角矩形（对齐浏览器标签选中视觉） */
export const CONTEXT_TAB_ACTIVE_CLASS =
  'bg-muted text-foreground font-medium'

/** 未选中态：透明底，hover 轻灰圆角预览 */
export const CONTEXT_TAB_INACTIVE_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted/50 dark:hover:bg-muted/30'

/** 进入 closing 状态时叠加的类：宽度 / 内边距 / 透明度 一起收到 0 */
const NORMAL_TAB_CLOSING_CLASS =
  '!min-w-0 !max-w-0 !px-0 !py-0 !ml-0 !mr-0 opacity-0 pointer-events-none border-transparent'

/** 所有 tab 共享的过渡动画（width / padding / opacity 一起平滑） */
const NORMAL_TAB_TRANSITION_CLASS = 'transition-all [transition-duration:120ms] ease-out'

interface NormalTabProps {
  item: ContextItem
  registry: ContextRegistry
  isActive: boolean
  isClosing: boolean
  isDragging?: boolean
  /** Codex 风格排序预览：源标签作为空占位移动，跨过的标签平滑让位。 */
  reorderOffsetX?: number
  /** 用于 ScrollArea 自动滚动到 active tab */
  innerRef?: React.Ref<HTMLDivElement>
  /** i18n.t 函数（来自 useTranslation('context')） */
  t: ContextTabsT
  onSelect: () => void
  /**
   * 用户主动请求关闭。注意：实际关闭动作 + 动画状态由父级 useCloseAnimation 协调，
   * 本组件仅"通知"父级。父级会立即 setClosing 同时调用 onCloseItem。
   */
  onRequestClose: () => void
  /** 中键关闭事件（与 onRequestClose 走同一路径，但走 onAuxClick） */
  onMiddleClickClose: (e: React.MouseEvent) => void
  /** 右键菜单 */
  onContextMenu: (e: React.MouseEvent) => void
  /** 拖拽 props（由 useTabReorder.makeTabDragProps 生成） */
  dragProps: TabDragProps<HTMLDivElement>
}

const NormalTabImpl: React.ForwardRefRenderFunction<HTMLDivElement, NormalTabProps> = (
  {
    item,
    registry,
    isActive,
    isClosing,
    isDragging = false,
    reorderOffsetX = 0,
    innerRef,
    t,
    onSelect,
    onRequestClose,
    onMiddleClickClose,
    onContextMenu,
    dragProps,
  },
  forwardedRef,
) => {
  const dirtyInfo = useTabDocDirtyIndicator(item)
  const contextState = useOptionalSpaceContextState()
  const focusedCanvas = useUIStore(state => state.focusedCanvas)
  const setFocusedCanvas = useUIStore(state => state.setFocusedCanvas)
  const taskViewMode = useSpaceViewPrefsStore(state => (
    contextState && isIsolatedScopeKey(contextState.tabScopeKey)
      ? state.getTaskViewMode(contextState.tabScopeKey)
      : null
  ))
  const setTaskViewModeForScope = useSpaceViewPrefsStore(state => state.setTaskViewModeForScope)
  const isDiscarded = Boolean(item.meta?.discarded)
  const tabLabel = registry.getTabLabel(item)
  const isClosable = registry.isClosable(item)
  // 任务 / IM 会话统一走 taskViewMode；桌面等无三态布局的场景保留临时铺满。
  const canFocusCanvas =
    (item.type === 'tabdoc' || item.type === 'tabdata') &&
    Boolean(contextState?.tabScopeKey)
  const usesUnifiedAppFocus = isIsolatedScopeKey(contextState?.tabScopeKey)
  const isUnifiedAppFocused =
    canFocusCanvas &&
    usesUnifiedAppFocus &&
    isActive &&
    taskViewMode === 'app-focus'
  const isLegacyTemporarilyFocused =
    canFocusCanvas &&
    !usesUnifiedAppFocus &&
    focusedCanvas?.scopeKey === contextState?.tabScopeKey &&
    focusedCanvas?.tabKey === item.tabKey
  const isFocused = usesUnifiedAppFocus
    ? isUnifiedAppFocused
    : isLegacyTemporarilyFocused
  const focusActionLabel = usesUnifiedAppFocus ? '应用聚焦' : '临时展开'
  const focusButtonLabel = isFocused ? `退出${focusActionLabel}` : focusActionLabel

  const handleToggleFocus = (event: React.MouseEvent) => {
    event.stopPropagation()
    if (!contextState) return
    onSelect()

    if (usesUnifiedAppFocus) {
      const nextMode = isUnifiedAppFocused ? 'split' : 'app-focus'
      captureTaskViewModeMorph(taskViewMode ?? undefined, nextMode)
      setTaskViewModeForScope(contextState.tabScopeKey, nextMode)
      // 热更新或旧会话可能仍留有同 scope 的临时态；只清当前 scope，勿打断桌面现场。
      if (focusedCanvas?.scopeKey === contextState.tabScopeKey) {
        setFocusedCanvas(null)
      }
      return
    }

    setFocusedCanvas(
      isLegacyTemporarilyFocused
        ? null
        : { scopeKey: contextState.tabScopeKey, tabKey: item.tabKey },
    )
  }

  // 合并 ref：innerRef（active scroll target）+ forwardedRef（测试 / 父组件用）
  const setRef = (node: HTMLDivElement | null) => {
    if (typeof innerRef === 'function') innerRef(node)
    else if (innerRef && 'current' in innerRef) {
      ;(innerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    }
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef && 'current' in forwardedRef) {
      ;(forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    }
  }

  return (
    <div
      ref={setRef}
      data-tab-item
      data-tab-key={item.tabKey}
      data-tab-reorder-key={item.tabKey}
      data-tab-closing={isClosing ? 'true' : undefined}
      data-tab-dragging={isDragging ? 'true' : undefined}
      data-tab-placeholder={isDragging ? 'true' : undefined}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      className={cn(
        NORMAL_TAB_BASE_CLASS,
        NORMAL_TAB_TRANSITION_CLASS,
        canFocusCanvas ? (isClosable ? 'pl-2 pr-11' : 'pl-2 pr-6') : (isClosable ? 'pl-2 pr-6' : 'px-2'),
        isDiscarded
          ? 'text-muted-foreground/60 border-dashed border-muted-foreground/60 hover:text-muted-foreground hover:bg-muted/30'
          : isActive
            ? CONTEXT_TAB_ACTIVE_CLASS
            : CONTEXT_TAB_INACTIVE_CLASS,
        isDragging && 'cursor-grabbing border-dashed border-border/60 bg-muted/25 text-transparent hover:bg-muted/25',
        isClosing && NORMAL_TAB_CLOSING_CLASS,
      )}
      style={reorderOffsetX ? { transform: `translateX(${reorderOffsetX}px)` } : undefined}
      title={
        isDiscarded ? t('tab.discarded.tooltip', 'Tab hibernated - click to restore') : tabLabel
      }
      onClick={onSelect}
      onAuxClick={isClosable ? onMiddleClickClose : undefined}
      onMouseDown={e => {
        if (isClosable && e.button === 1) e.preventDefault()
      }}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
      onContextMenu={onContextMenu}
      {...dragProps}
    >
      <div
        data-tab-drag-content
        className={cn('contents', isDragging && 'invisible')}
        inert={isDragging ? true : undefined}
      >
        <span
          className={cn(
            'shrink-0 grayscale',
            isDiscarded ? 'opacity-40' : !isActive && 'opacity-60',
            isActive && !isDiscarded && 'grayscale-0 opacity-100',
          )}
        >
          {registry.getTabIcon(item)}
        </span>
        {isDiscarded &&
          (item.meta?.restoring ? (
            <Loader2 className="h-3 w-3 shrink-0 text-muted-foreground/60 animate-spin" />
          ) : (
            <Moon className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          ))}
        <span className="min-w-0 truncate leading-[18px]">{tabLabel}</span>
        {dirtyInfo && (
          <DirtyIndicator
            status={dirtyInfo.status}
            forceVisible={isActive || dirtyInfo.status === 'error'}
            t={t}
          />
        )}
        {canFocusCanvas && (
          <button
            type="button"
            aria-label={focusButtonLabel}
            className={cn(
              'absolute right-5 top-1/2 -translate-y-1/2 transition-opacity p-0.5 rounded-sm z-floating',
              'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              CLOSE_BTN_CLASS,
            )}
            onKeyDown={event => event.stopPropagation()}
            onClick={handleToggleFocus}
          >
            {isFocused ? <Shrink className="h-3.5 w-3.5" /> : <Expand className="h-3.5 w-3.5" />}
          </button>
        )}
        {isClosable && (
          <button
            type="button"
            aria-label={t('tab.menu.close')}
            tabIndex={-1}
            className={cn(
              'absolute right-0.5 top-1/2 -translate-y-1/2 transition-opacity p-0.5 rounded-sm z-floating',
              'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
              CLOSE_BTN_CLASS,
            )}
            onClick={event => {
              event.stopPropagation()
              onRequestClose()
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

export const NormalTab = forwardRef(NormalTabImpl)
NormalTab.displayName = 'NormalTab'
