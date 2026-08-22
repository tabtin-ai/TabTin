/**
 * ThinkingBlockView — v2 §3.5.1.d Thinking UX 规范。
 *
 * 状态机：
 *   - **流式期间（finalized=false）**：STEP_ROW（Brain + ShinyText「思考中…」
 *     + hover 箭头）下方**默认展示实时流式预览窗口**——固定高度约 3 行
 *     （h-[66px]，CHAT_STEP_TEXT 22px 行高 × 3），内层 flex-col justify-end 让最新
 *     内容天然贴底（零 JS 滚动、零 per-delta 工作），顶部渐隐 mask 提示上方
 *     还有内容。点击折叠条切换「展开全文 / 收回预览」。纯文本渲染，不走
 *     Markdown（性能 + 流式期间 raw 文本契约）。预览容器从流式一开始就固定
 *     高度，虚拟列表行高尽早稳定、不随文本增长弹跳。
 *   - **finalized 后**：自动折叠为 `Thought for {X}s`（X = `entry.stoppedAt -
 *     entry.startedAt`，由 W4c 在 ContentBlockEntry 上 stamp）。折叠瞬间预览
 *     窗口用 height 66px → 0 的 200ms CSS 过渡塌掉（避免虚拟列表行高一次性
 *     跳变），过渡结束后卸载、不留占位。点击展开看完整 Markdown。
 *     **turn-end 事务**：若本实例亲历过 streaming 且 Context
 *     `shouldHoldThinkingPreviewBudget`（committing/settling），则 finalized
 *     后先钉住 66px 预算，phase → released/idle 后再走上述塌缩；无 Provider /
 *     历史消息 / 用户显式展开不受影响。
 *   - **redacted_thinking**：锁图标 + "Reasoning encrypted"——signature 不显示。
 *
 * **W4c · W4b-P1-1**：finalized 后显示 "Thought for Xs" 秒数。来源：
 *   1. 优先用 `entry.stoppedAt - entry.startedAt`（W4a `contentBlockStart` /
 *      `contentBlockStop` 时 stamp 的本地时间戳）
 *   2. 缺失则不显示秒数（fallback 到 "Thought" 单词，避免 "NaN s" 误导用户）
 *
 * v2 §3.5.1.i 默认偏好：thinking 默认折叠。本组件读 `default_block_state`
 * 用户偏好（W4b 先 hardcode 'collapsed'，settings 入口由后续 sub-task 接通）。
 *
 * 性能基线 第 2 项 < 500ms 首屏：finalized 后的折叠卡片不预渲染 Markdown，
 * 用户点开才 mount MarkdownRenderer。
 */

import React, { useState, useMemo, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, ChevronDown, ChevronRight, Loader2, Lock } from 'lucide-react'
import type { ThinkingBlock, RedactedThinkingBlock } from '@tabtin/agent-wire'
import { cn } from '@utils/cn'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { ShinyText } from '../markdown/ShinyText'
import {
  CARD_RADIUS,
  CHAT_STEP_TEXT,
  TEXT,
  TEXT_COLOR,
  BORDER,
  BG,
  ICON_SIZE,
  ANIMATION,
  STEP_ROW,
} from '../registry/chatDesignTokens'
import { blockEntryEqual, partialReasonText, type BlockRendererProps } from './types'
import { getThinkingBody } from '@utils/chat/thinkingBody'
import { useTypewriterText } from './useTypewriterText'
import { useBlockExpanded, blockExpandKey } from '@stores/chat/presentation/blockUiPrefs'
import { useTurnEndLayout } from '../viewport/TurnEndLayoutContext'

import { STREAMING_PREVIEW_HEIGHT_PX } from '../markdown/streamingPreviewHeight'

/**
 * 流式预览窗口高度：见 streamingPreviewHeight.ts（与 AgentAwaitingThought 共用）。
 */
export { STREAMING_PREVIEW_HEIGHT_PX }

/** finalize 折叠过渡时长（ms）——与 ANIMATION.collapse 的 duration-200 对齐，留 40ms 余量再卸载。 */
const PREVIEW_COLLAPSE_UNMOUNT_MS = 240

export const ThinkingBlockView: React.FC<BlockRendererProps> = React.memo(({ entry, tabScopeKey, suppressPartialReason, suppressInlineLoading = false }) => {
  const { t } = useTranslation('chat')
  const block = entry.block as ThinkingBlock | RedactedThinkingBlock

  // ── React Rules of Hooks 守门 ──────────────────────────────────────
  //
  // **所有 hook 调用必须无条件出现在组件顶部、所有 early return 之前**。
  // 旧版本把 `thoughtDurationSeconds` 的 `useMemo` 放在 `!entry.finalized`
  // early return 之后，导致同一个 entry 在 `finalized=false → true` 切换
  // 时 hooks 数量从 4 变 5 → React 抛 "Rendered more hooks than during
  // the previous render" → BlockTimelineItem 的 ErrorBoundary 兜底显示
  // FallbackBlockView "render-error · type=thinking"。
  //
  // 修法：把所有 useMemo / useState 提到 redacted_thinking + !finalized
  // 两个 early return 之前，让任意 entry / 任意状态走过的 hook 序列一致。
  // 计算值即便最终未渲染也不增加多少开销（thinkingText 计算 + 两次时间
  // 减法）。
  const thinkingText = getThinkingBody(block)

  // ── 平滑流式揭示（typewriter reveal）─────────────────────────────────
  //
  // thinking delta 按 chunk 到达（一帧一批、一批十几个字符），直接渲染整块
  // 会「一坨字闪出」。共享 hook 把积压摊到后续帧逐字揭示（自适应追赶），
  // 详见 useTypewriterText。流式期间渲染「已揭示前缀」；finalized 后恒为
  // 全量文本；用户停止冻结揭示。
  const isRevealActive = block.type === 'thinking' && !entry.finalized
  const freezeReveal = entry.partialReason === 'aborted'
  const visibleText = useTypewriterText(thinkingText, isRevealActive, freezeReveal)

  // 默认折叠（v2 §3.5.1.i）；流式期间也是 STEP_ROW 折叠行。
  // finalized 展开态提到 store（按 block_id）——虚拟列表把本消息滚出视口 remount 后
  // 仍能读回，不再「后续消息刷新导致展开态丢失」。streamingExpanded 属流式瞬态、保留本地。
  const [expanded, setExpanded] = useBlockExpanded(
    entry.block_id ? blockExpandKey(entry.block_id) : null,
    false,
  )
  const [streamingExpanded, setStreamingExpanded] = useState(false)

  // W4c · W4b-P1-1：从 entry.startedAt / stoppedAt 推算秒数（contentBlockStart
  // / contentBlockStop 时 stamp）。两个时间戳都存在且 ≥1s 才显示秒数；缺失或
  // <1s 走 "已思考" 兜底（不带秒数）——状态简化为「思考中 / 已思考」两态，
  // 避免「已思考 <1 秒」的尴尬文案，也不显示 "NaN s" 等误导文案。
  const thoughtDurationSeconds = useMemo(() => {
    if (entry.startedAt == null || entry.stoppedAt == null) return undefined
    const ms = entry.stoppedAt - entry.startedAt
    if (!Number.isFinite(ms) || ms < 0) return undefined
    if (ms < 1000) return undefined
    return String(Math.round(ms / 1000))
  }, [entry.startedAt, entry.stoppedAt])

  // finalize 折叠过渡：finalized 翻 true 的瞬间保留预览占位。
  // 仅在「本组件实例亲历过流式态」时触发；历史消息初次挂载即 finalized，不播动画。
  //
  // turn-end 事务（Phase 2）：若 Context 要求 hold thinking 预算（committing/settling），
  // finalized 后先钉在 66px，等 phase → released/idle 再走现有 66→0 + 卸载。
  // 无 Provider 时 shouldHoldThinkingPreviewBudget=false，行为与旧版一致。
  const { shouldHoldThinkingPreviewBudget } = useTurnEndLayout()
  const hasEverStreamedRef = useRef(!entry.finalized)
  const collapseFinishedRef = useRef(false)
  const [collapsingPreview, setCollapsingPreview] = useState(false)
  const [previewShrunk, setPreviewShrunk] = useState(false)
  // 在浏览器绘制 finalized 首帧前同步挂好 66px 塌缩占位，避免先掉高再补回。
  useLayoutEffect(() => {
    if (!entry.finalized) {
      hasEverStreamedRef.current = true
      collapseFinishedRef.current = false
      return undefined
    }
    if (!hasEverStreamedRef.current || collapseFinishedRef.current) return undefined

    setCollapsingPreview(true)

    // turn-end hold：钉住 66px，不启动塌缩 timer（避免永久留白由 phase machine 释放）
    if (shouldHoldThinkingPreviewBudget) {
      setPreviewShrunk(false)
      return undefined
    }

    // hold 结束或无 hold：复用现有 66→0 过渡，结束后卸载
    const raf = requestAnimationFrame(() => setPreviewShrunk(true))
    const timer = window.setTimeout(() => {
      setCollapsingPreview(false)
      setPreviewShrunk(false)
      collapseFinishedRef.current = true
    }, PREVIEW_COLLAPSE_UNMOUNT_MS)
    return () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
    }
  }, [entry.finalized, shouldHoldThinkingPreviewBudget])

  // ── 分支渲染（所有 hooks 都已在上方完成调用） ───────────────────────

  // redacted_thinking 独立分支——signature 不可展开
  if (block.type === 'redacted_thinking') {
    return (
      <div
        className={cn(
          'flex items-center gap-1.5 my-1 px-2.5 py-1 border',
          CARD_RADIUS,
          BORDER.subtle,
          BG.header,
          CHAT_STEP_TEXT,
          TEXT_COLOR.muted,
        )}
        data-testid="block-redacted-thinking"
      >
        <Lock className={cn(ICON_SIZE.md, 'text-warning/80 flex-shrink-0')} />
        <span>{t('blockTimeline.thinking.redacted', { defaultValue: 'Reasoning encrypted' })}</span>
      </div>
    )
  }

  // 流式期间：STEP_ROW 折叠行 + 默认可见的实时预览窗口。
  //
  //   - 预览窗口固定高度（3 行 CHAT_STEP_TEXT），从流式一开始就占位——虚拟列表
  //     行高一次稳定，文本增长不会引起对话框弹跳。
  //   - 内层 flex-col justify-end 让最新内容天然贴底跟随（内容溢出被顶部
  //     clip），零滚动事件、零 per-delta JS 工作。
  //   - 顶部渐隐 mask 提示上方还有内容。
  //   - 点击折叠条切换「展开全文（无高度上限）/ 收回预览」二态。
  //   - suppressInlineLoading（会话级等待壳 / 思考行可见）时不再显示 inline
  //     Loader2 避免双 spinner，但预览窗口照常显示。
  //   - 纯文本渲染（流式期间 raw 文本契约，finalized 后才走 Markdown）。
  //   - 尚无正文的空 thinking 块：不渲染，交给 AgentAwaitingThought
  //     （首段「思考中…」/ 步间「正在计划下一步...」），避免两套 Brain 行打架。
  if (!entry.finalized) {
    if (!thinkingText.trim()) return null
    return (
      <div className="my-0.5" data-testid="block-thinking-streaming">
        <button
          type="button"
          className={STEP_ROW.button}
          onClick={() => setStreamingExpanded((prev) => !prev)}
          aria-expanded={streamingExpanded}
        >
          <Brain className={cn(ICON_SIZE.md, 'shrink-0', STEP_ROW.icon)} />
          <ShinyText className={cn(STEP_ROW.label, 'truncate')}>
            {t('blockTimeline.thinking.streaming', { defaultValue: 'Thinking…' })}
          </ShinyText>
          <span
            className={cn(
              'shrink-0 transition-opacity',
              streamingExpanded ? 'opacity-60' : 'opacity-0 group-hover/step:opacity-60',
            )}
          >
            {streamingExpanded
              ? <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'transition-colors group-hover/step:text-foreground/80')} />
              : <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'transition-colors group-hover/step:text-foreground/80')} />}
          </span>
        </button>
        {streamingExpanded ? (
          <div
            className={cn(
              'mt-1 ml-3 pl-2 border-l',
              BORDER.subtle,
              CHAT_STEP_TEXT,
              TEXT_COLOR.muted,
              'opacity-60 whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
            )}
            data-testid="thinking-streaming-full"
          >
            {visibleText}
            {!suppressInlineLoading && (
              <Loader2 className={cn(ICON_SIZE.sm, 'inline-block ml-1', ANIMATION.spin)} />
            )}
          </div>
        ) : (
          <div
            className={cn('relative mt-1 ml-3 overflow-hidden border-l pl-2', BORDER.subtle)}
            style={{
              height: STREAMING_PREVIEW_HEIGHT_PX,
              maskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
              WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
            }}
            data-testid="thinking-streaming-preview"
          >
            <div className="flex h-full flex-col justify-end">
              <div
                className={cn(
                  CHAT_STEP_TEXT,
                  TEXT_COLOR.muted,
                  'opacity-60 whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
                )}
              >
                {visibleText}
                {!suppressInlineLoading && (
                  <Loader2 className={cn(ICON_SIZE.sm, 'inline-block ml-1', ANIMATION.spin)} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── W4.5 §step row 视觉统一 ──
  //
  // 与 CompactToolUseRow（read / search / list 等 compact 工具）共享一套样式
  // 规范，避免"thinking 是橘色 Brain + 边框 button + 左侧 chevron，compact tool
  // 是灰色 icon + 无背景 + 无 chevron"的两套独立设计——这种视觉分裂在用户
  // 截图反馈里被一眼看出来"UX 非常混乱"。
  //
  // 统一规范（见 STEP_ROW）：
  //   - 容器：透明底，hover 仅提亮文字/图标
  //   - 字号：`CHAT_STEP_TEXT`
  //   - icon 颜色：`text-muted-foreground/70`（去掉 thinking 之前的橘色 accent —
  //     视觉锚点改用"主对话区位置"+"动词文案"，不再靠 icon 染色）
  //   - 动词：`text-foreground/85`，摘要：`text-muted-foreground/60`
  //   - 展开符号：右侧、默认 `opacity-0`、hover/expanded 时显现
  return (
    <div className="my-0.5" data-testid="block-thinking">
      <button
        type="button"
        className={STEP_ROW.button}
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <Brain className={cn(ICON_SIZE.md, 'shrink-0', STEP_ROW.icon)} />
        <span className={STEP_ROW.label}>
          {thoughtDurationSeconds
            ? t('blockTimeline.thinking.thoughtForSeconds', {
                seconds: thoughtDurationSeconds,
                defaultValue: `Thought for ${thoughtDurationSeconds}s`,
              })
            : t('blockTimeline.thinking.thought', { defaultValue: 'Thought' })}
        </span>
        {/* 下拉箭头：保持在末尾，按需显示（hover / 展开） */}
        <span
          className={cn(
            'shrink-0 transition-opacity',
            expanded ? 'opacity-60' : 'opacity-0 group-hover/step:opacity-60',
          )}
        >
          {expanded
            ? <ChevronDown className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'transition-colors group-hover/step:text-foreground/80')} />
            : <ChevronRight className={cn(ICON_SIZE.md, TEXT_COLOR.faint, 'transition-colors group-hover/step:text-foreground/80')} />}
        </span>
      </button>
      {collapsingPreview && !expanded && (
        // finalize 瞬间的塌缩占位：从流式预览的 66px 平滑收到 0，过渡结束卸载。
        // aria-hidden——纯视觉过渡，内容已由「Thought for Xs」行代表。
        <div
          className={cn(
            'relative ml-3 overflow-hidden border-l pl-2 transition-[height,margin-top] duration-200 ease-out',
            BORDER.subtle,
          )}
          style={{
            height: previewShrunk ? 0 : STREAMING_PREVIEW_HEIGHT_PX,
            marginTop: previewShrunk ? 0 : 4,
            maskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
            WebkitMaskImage: 'linear-gradient(to bottom, transparent 0, black 24px)',
          }}
          data-testid="thinking-preview-collapsing"
          aria-hidden="true"
        >
          <div className="flex h-full flex-col justify-end">
            <div
              className={cn(
                CHAT_STEP_TEXT,
                TEXT_COLOR.muted,
                'opacity-60 whitespace-pre-wrap break-words [overflow-wrap:anywhere]',
              )}
            >
              {thinkingText}
            </div>
          </div>
        </div>
      )}
      {expanded && thinkingText && (
        <div
          className={cn(
            'mt-1 ml-3 pl-2 border-l',
            BORDER.subtle,
            // W4.5 §step row 视觉统一 polish：thinking 是辅助批注（用户判断
            // AI 思路用，不是核心回复内容），视觉权重应低于主回复 markdown。
            // `opacity-60` 让整段子树（含 markdown 内的标题 / 列表 / 代码块
            // 等所有子元素）一致淡化——一致淡化体感，避免
            // thinking 跟主回复视觉权重打架。
            'opacity-60',
          )}
        >
          <MarkdownRenderer content={thinkingText} tabScopeKey={tabScopeKey} lightweight={false} renderLevel={1} />
        </div>
      )}
      {entry.partial && !suppressPartialReason && (
        // W4c · W4a-L12：thinking 块也按 partialReason 显示统一文案，避免
        // text 显示"已中断"而 thinking 看起来"正常完成"的分裂体感。
        <div className={cn('mt-0.5 ml-1', TEXT.meta, TEXT_COLOR.faint, 'italic')}>
          {partialReasonText(entry.partialReason, t)}
        </div>
      )}
    </div>
  )
}, blockEntryEqual)
ThinkingBlockView.displayName = 'ThinkingBlockView'
