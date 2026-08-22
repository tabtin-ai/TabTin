/**
 * CollapsibleToolCardGroup — 连续工具卡片的稳定分组容器。
 *
 * **结构稳定不变量（渲染隔离， 家族）**：连续工具步永远归入本组，工具卡始终
 * 在同一个 children 容器里（`key="body"`），追加新步 / 尾步 settle **不换父节点、
 * 不 remount**。组头显隐与折叠露出只切换本容器内渲染哪些子节点，不移动子树。
 *
 * 展示形态（由 `count` / `showLastWhenCollapsed` 决定，不再随流式 mount 时机跳变）：
 *   - `count <= threshold`：不显示组头，平铺全部子节点（视觉与单卡一致）。
 *   - `count > threshold` 折叠：显示组头（图标 + 「N 个步骤」+ 计数徽标 + 箭头）；若 `showLast-
 *     WhenCollapsed`（本组末条是进行中尾步）则额外露出最后一条实时可见。
 *   - `count > threshold` 展开：显示组头 + 全部子节点。
 *
 * **高度契约（Phase 2 / ）**：流式自动折叠必须回收高度，禁止用
 * `invisible` 占位留下等大空白。`holdVisibleSteps` 仅为显式 opt-in API 保留
 *（默认关闭）；活跃 run 只应接线 `disableSizeLayout`。用户显式折叠照常回收。
 * `disableSizeLayout` 关闭流式热路径的 max-height 过渡。
 *
 * **动效（agent-motion-design）**：组头出现后，折叠/展开走 `chat-motion-tool-group-content`
 *（240ms max-height）；收拢瞬间计数徽标 0→N（300ms rAF）。动态内容高度由
 * scrollHeight 测量写入，不用固定小 max-height 截断。
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Layers, ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import { useScopedResizeObserver } from '@hooks/spaceActivity'
import { BG, TEXT_COLOR, ICON_SIZE, STEP_ROW, TOOL_CARD_GROUP } from '../registry/chatDesignTokens'
import {
  useBlockExpanded,
  groupExpandKey,
  useChatBlockUiPrefsStore,
} from '@stores/chat/presentation/blockUiPrefs'
import {
  prefersReducedMotion,
  runCountUp,
  TOOL_GROUP_COLLAPSE_MS,
} from './toolGroupMotion'

interface CollapsibleToolCardGroupProps {
  children: React.ReactNode
  /** 组身份（= 组首 block_id）：展开态按它存进 store，跨 remount/虚拟化回收存活。 */
  groupKey?: string
  /** 超过此数量才显示组头 / 折叠（默认 3，即 ≥4 个才折叠）。 */
  threshold?: number
  /** 默认是否展开（默认折叠）。 */
  defaultExpanded?: boolean
  /**
   * 摘要行「N 个步骤」的计数。缺省时回退到 children 数量（不精确）。
   *
   * **一步 = 一个可见执行步骤**：调用方（BlockTimeline）应数 thinking + tool_use，
   * **不含** tool_result（结果是工具调用的一部分、且以 null 子节点混在 children 里）
   * ——否则计数会比实际步数偏多（ live 修）。
   */
  count?: number
  /**
   * 首次跨过折叠阈值时，尾步仍在执行则暂不显示组头。避免第 N 步出现的同时把
   * 之前可见的步骤瞬间收进组内；当前步拿到结果后才按常规折叠。
   */
  deferCollapse?: boolean
  /**
   * 折叠态下是否露出最后一条子节点——本组末条正是进行中的尾步时置真，让用户折叠
   * 也能实时看到当前步骤（「显示最后一条」下沉为组的能力，替代把尾步拎到组外）。
   */
  showLastWhenCollapsed?: boolean
  /**
   * 显式 opt-in：自动折叠时仍挂载已展示步骤并保留布局高度。
   * 默认关闭——流式接线会产生等大空白。用户显式折叠仍可回收。
   */
  holdVisibleSteps?: boolean
  /**
   * 流式热路径：禁用 max-height 过渡，避免高度动画扰动滚动。
   */
  disableSizeLayout?: boolean
}

export { prefersReducedMotion, runCountUp } from './toolGroupMotion'

export const CollapsibleToolCardGroup: React.FC<CollapsibleToolCardGroupProps> = ({
  children,
  groupKey,
  threshold = TOOL_CARD_GROUP.collapseThreshold,
  defaultExpanded = false,
  count,
  deferCollapse = false,
  showLastWhenCollapsed = false,
  holdVisibleSteps = false,
  disableSizeLayout = false,
}) => {
  const { t } = useTranslation('chat')
  const items = React.Children.toArray(children).filter(Boolean)
  const expandKey = groupKey ? groupExpandKey(groupKey) : null
  const [expanded, setExpanded] = useBlockExpanded(expandKey, defaultExpanded)
  // 有 groupKey 时，store 里显式 false = 用户折叠（跨虚拟化 remount 仍回收）；
  // 无 key 时用本地标记。未写入 store 的自动折叠才能 hold。
  const storedExpanded = useChatBlockUiPrefsStore((s) =>
    expandKey != null ? s.expandedByKey[expandKey] : undefined,
  )
  const [localUserCollapsed, setLocalUserCollapsed] = useState(false)
  const userForcedCollapse =
    expandKey != null ? storedExpanded === false : localUserCollapsed
  // 展示步数：优先用调用方给的精确工具数；缺省回退 children 数量。
  const stepCount = count ?? items.length
  const stepCountRef = useRef(stepCount)
  stepCountRef.current = stepCount
  // 只延迟「首次」出现组头。已经折叠过的历史组继续保持其形态，后续新尾步不
  // 会令整个组突然重新平铺。
  const hasShownHeaderRef = useRef(false)
  const showHeader = stepCount > threshold && (!deferCollapse || hasShownHeaderRef.current)
  useEffect(() => {
    if (showHeader) hasShownHeaderRef.current = true
  }, [showHeader])

  const isHolding =
    holdVisibleSteps && showHeader && !expanded && !userForcedCollapse

  // CSS max-height 折叠：收拢过程中短暂保留全量子节点，动画结束后再按折叠态裁剪。
  const [collapseAnimating, setCollapseAnimating] = useState(false)
  const panelInnerRef = useRef<HTMLDivElement>(null)
  const [panelInnerElement, setPanelInnerElement] = useState<HTMLDivElement | null>(null)
  const setPanelInnerNode = useCallback((node: HTMLDivElement | null) => {
    panelInnerRef.current = node
    setPanelInnerElement(node)
  }, [])
  const [panelMaxHeight, setPanelMaxHeight] = useState<number | null>(null)
  const prevExpandedRef = useRef(expanded)
  const useCssCollapse = showHeader && !disableSizeLayout && !isHolding

  // 计数徽标：历史已折叠 → 直接 N；收拢瞬间 → 0→N count-up。
  const [badgeValue, setBadgeValue] = useState<number | null>(
    () => (showHeader && !expanded ? stepCount : null),
  )
  const cancelCountUpRef = useRef<(() => void) | null>(null)

  const stopCountUp = useCallback(() => {
    cancelCountUpRef.current?.()
    cancelCountUpRef.current = null
  }, [])

  const startCountUp = useCallback((target: number) => {
    stopCountUp()
    let finishedSynchronously = false
    const cancel = runCountUp(target, setBadgeValue, {
      reducedMotion: prefersReducedMotion(),
      onComplete: () => {
        finishedSynchronously = true
        cancelCountUpRef.current = null
        setBadgeValue(stepCountRef.current)
      },
    })
    cancelCountUpRef.current = finishedSynchronously ? null : cancel
  }, [stopCountUp])

  useEffect(() => () => stopCountUp(), [stopCountUp])

  useEffect(() => {
    if (!showHeader || expanded) {
      stopCountUp()
      setBadgeValue(null)
    }
  }, [showHeader, expanded, stopCountUp])

  // 折叠态步数变化：同步徽标最终值；count-up 进行中不打断
  useEffect(() => {
    if (!showHeader || expanded) return
    if (cancelCountUpRef.current != null) return
    setBadgeValue(stepCount)
  }, [stepCount, showHeader, expanded])

  // collapseAnimating 只用 state 驱动渲染，不进本 effect deps——否则会 cleanup 掉
  // 收拢完成的 setTimeout，导致动画永远不结束、步骤无法卸载。
  const collapseAnimatingRef = useRef(false)

  useLayoutEffect(() => {
    const wasExpanded = prevExpandedRef.current
    prevExpandedRef.current = expanded

    if (!useCssCollapse) {
      collapseAnimatingRef.current = false
      setCollapseAnimating(false)
      setPanelMaxHeight(null)
      return
    }

    const inner = panelInnerRef.current
    const reduced = prefersReducedMotion()

    if (wasExpanded && !expanded) {
      // 收拢瞬间：徽标 count-up + max-height → 0
      startCountUp(stepCountRef.current)

      if (reduced || !inner) {
        collapseAnimatingRef.current = false
        setCollapseAnimating(false)
        setPanelMaxHeight(0)
        return
      }

      collapseAnimatingRef.current = true
      setCollapseAnimating(true)
      const from = inner.scrollHeight
      setPanelMaxHeight(from)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => setPanelMaxHeight(0))
      })
      const done = window.setTimeout(() => {
        collapseAnimatingRef.current = false
        setCollapseAnimating(false)
        setPanelMaxHeight(0)
      }, TOOL_GROUP_COLLAPSE_MS)
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
        window.clearTimeout(done)
      }
    }

    if (!wasExpanded && expanded) {
      // 展开：先挂载内容，再量高并过渡到 scrollHeight，结束后放开为 auto（null）
      collapseAnimatingRef.current = false
      setCollapseAnimating(false)
      if (reduced || !inner) {
        setPanelMaxHeight(null)
        return
      }
      setPanelMaxHeight(0)
      let raf2 = 0
      const raf1 = requestAnimationFrame(() => {
        const to = panelInnerRef.current?.scrollHeight ?? 0
        raf2 = requestAnimationFrame(() => setPanelMaxHeight(to))
      })
      const done = window.setTimeout(() => setPanelMaxHeight(null), TOOL_GROUP_COLLAPSE_MS)
      return () => {
        cancelAnimationFrame(raf1)
        cancelAnimationFrame(raf2)
        window.clearTimeout(done)
      }
    }

    // 历史已折叠：钉死 max-height:0，避免无约束盒子在内容短暂挂载时撑开
    if (!expanded && !collapseAnimatingRef.current) {
      setPanelMaxHeight((prev) => (prev == null ? 0 : prev))
    }
  }, [expanded, useCssCollapse, startCountUp])

  // 展开态内容尺寸变化：续写 max-height，避免固定小值截断动态内容。
  useScopedResizeObserver(panelInnerElement, () => {
    if (!useCssCollapse || !expanded || !panelInnerElement) return
    setPanelMaxHeight((prev) => {
      if (prev == null) return prev
      const next = panelInnerElement.scrollHeight
      return next > prev ? next : prev
    })
  })

  const handleToggle = () => {
    const next = !expanded
    if (expandKey == null) {
      setLocalUserCollapsed(!next)
    }
    setExpanded(next)
  }

  // 折叠动画中仍渲染全部步骤，结束后再按折叠态裁剪（含 showLastWhenCollapsed）。
  const showAllForMotion = useCssCollapse && (expanded || collapseAnimating)

  let bodyContent: React.ReactNode
  if (!showHeader || showAllForMotion || expanded) {
    bodyContent = items
  } else if (isHolding) {
    const heldItems =
      showLastWhenCollapsed && items.length > 0 ? items.slice(0, -1) : items
    const lastItem =
      showLastWhenCollapsed && items.length > 0 ? items[items.length - 1] : null
    bodyContent = (
      <>
        {heldItems.length > 0 && (
          <div
            data-testid="tool-card-group-held-steps"
            className="invisible"
            aria-hidden="true"
            // React 19：inert 阻止焦点与点击，同时保留布局盒（不用 display:none）
            inert
          >
            {heldItems}
          </div>
        )}
        {lastItem}
      </>
    )
  } else {
    bodyContent =
      showLastWhenCollapsed && items.length > 0 ? items[items.length - 1] : null
  }

  const bodyClassName = cn(
    'flex flex-col gap-0.5 overflow-hidden',
    useCssCollapse && 'chat-motion-tool-group-content',
    showHeader && expanded && 'mt-0.5',
  )

  const panelStyle: React.CSSProperties | undefined = useCssCollapse
    ? { maxHeight: panelMaxHeight == null ? undefined : panelMaxHeight }
    : undefined

  return (
    <div className={showHeader ? 'my-0.5' : undefined} data-testid="tool-card-group">
      {showHeader && (
        <button
          key="header"
          type="button"
          className={STEP_ROW.button}
          onClick={handleToggle}
          aria-expanded={expanded}
          data-testid="tool-card-group-header"
        >
          <Layers className={cn(ICON_SIZE.md, 'shrink-0', STEP_ROW.icon)} />
          <span className={STEP_ROW.label}>
            {t('card.toolGroupCount', {
              count: stepCount,
              defaultValue: '执行详情',
            })}
          </span>
          {badgeValue != null && !expanded && (
            <span
              data-testid="tool-card-group-count-badge"
              className={cn(
                'shrink-0 rounded-full px-2 py-px font-mono text-caption tabular-nums text-muted-foreground/60',
                BG.accent,
              )}
            >
              {badgeValue}
            </span>
          )}
          <span
            className={cn(
              'shrink-0 transition-opacity',
              expanded ? 'opacity-100' : 'opacity-0 group-hover/step:opacity-100',
            )}
          >
            {expanded
              ? <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'transition-colors group-hover/step:text-foreground')} />
              : <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.muted, 'transition-colors group-hover/step:text-foreground')} />}
          </span>
        </button>
      )}
      {/* 子节点容器 key 恒定为 "body"——组头出现/消失、折叠/展开都不改变本容器身份，
          容器内的工具卡不换父节点、不 remount（渲染隔离的关键）。 */}
      <div
        key="body"
        className={bodyClassName}
        style={panelStyle}
        data-testid="tool-card-group-panel-body"
        data-layout-size="false"
        data-css-collapse={useCssCollapse ? 'true' : 'false'}
      >
        <div ref={setPanelInnerNode} className="flex flex-col gap-0.5">
          {bodyContent}
        </div>
      </div>
    </div>
  )
}

export default CollapsibleToolCardGroup
