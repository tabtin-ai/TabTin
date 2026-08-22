/**
 * TokenUsageRing — 会话 Token 消耗圆环
 *
 * 以 SVG 圆环展示当前会话 token 用量占模型上下文窗口的比例，
 * hover 显示详细统计（输入/输出/总计/上下文窗口）。
 */

import React, { useMemo, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { formatCreditsAuto } from '@/utils/formatBilling'
import { useBillingStore } from '../../../stores/useBillingStore'
import { useTranslation } from 'react-i18next'

interface TokenUsageRingProps {
  /** 输入 tokens */
  inputTokens: number
  /** 输出 tokens */
  outputTokens: number
  /** 当前请求的上下文 tokens（用于计算窗口占用百分比） */
  contextTokens: number
  /** 模型上下文窗口大小 */
  contextWindow: number
  /**
   * contextTokens 的可信度来源：
   *   - `last_call`：runtime emit 的精确 last_* 字段（2026-05-10+），无失真。
   *   - `turn_accum`：fallback 到 turn 累加字段，多 LLM 调用 turn 中可能偏高 2-3x。
   *   - `post_compact`：刚压缩、还没发下一条消息时的即时估算（anchor − tokens_freed），
   *     口径含固定开销、与下一次真实调用一致；下次回复后自动校准。
   *   - `none` / undefined：无 anchor，整环靠 rough estimate。
   * 走 `turn_accum` / `post_compact` 时 tooltip 加小字提示。
   */
  contextSource?: 'last_call' | 'turn_accum' | 'post_compact' | 'none'
  /** 预估费用（点券），由父组件根据模型单价计算传入；无值时不展示 */
  estimatedCost?: number
  /** 后端实际扣费（点券），优先于 estimatedCost 展示 */
  creditsConsumed?: number
  /** 缓存复用 token（会话累计，从 assistant 消息 metadata 汇总） */
  cacheReadTokens?: number
  /** 是否存在缓存复用字段；用于区分“未知”和“明确为 0” */
  hasCacheReadTokens?: boolean
  /** 摘要压缩消耗 token（会话累计，从 assistant 消息 metadata 汇总） */
  compactInputTokens?: number
  /** 深度思考 token（会话累计，从 assistant 消息 metadata 汇总） */
  reasoningTokens?: number
  /** 会话中任意一条消息存在扣费失败 */
  chargeFailed?: boolean
  /** 会话当前为 BYOK（最近一条 assistant 消息使用自带 API Key），不扣 TabTin 点券 */
  isByok?: boolean
  /** 会话中同时出现过 BYOK 与非 BYOK 扣费（切换模型等场景） */
  hasMixedBilling?: boolean
  /** 尺寸（直径，px） */
  size?: number
}

/** 格式化 token 数字 */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** Tooltip / 详情条 — 高占用时仍用语义色，便于在主动查看时区分风险 */
function getColorScheme(percent: number) {
  if (percent >= 85) return { twText: 'text-destructive', twBg: 'bg-destructive' }
  if (percent >= 65) return { twText: 'text-warning', twBg: 'bg-warning' }
  return { twText: 'text-muted-foreground', twBg: 'bg-muted-foreground' }
}

export const TokenUsageRing: React.FC<TokenUsageRingProps> = ({
  inputTokens,
  outputTokens,
  contextTokens,
  contextWindow,
  contextSource,
  estimatedCost,
  creditsConsumed,
  cacheReadTokens,
  hasCacheReadTokens,
  compactInputTokens,
  reasoningTokens,
  chargeFailed,
  isByok,
  hasMixedBilling,
  /** 默认显著小于工具栏发送按钮（h-7 w-7 ≈ 28px），避免视觉权重压过主操作 */
  size = 14,
}) => {
  const { t } = useTranslation('chat')
  const [showTooltip, setShowTooltip] = useState(false)
  const ringRef = useRef<HTMLDivElement>(null)
  // PRD-04 Wave 5 任务 4：`showPerMessageCost` 开关统一控制所有费用数字的展示。
  // 关闭时隐藏「已消费 X 点券」与「预估费用」两行——但圆环本身、token 计数
  // （输入/输出累计/缓存复用/深度思考/摘要压缩/会话累计/当前上下文/上下文窗口）
  // 都属于 token 视图，不是"费用"，保持展示。BYOK 标识行（"自备密钥"）也属于
  // 计费语义，一并受开关控制。
  // 二次收尾任务 3：`⚠ 部分费用计算失败` 警告也属于费用语义——管理员关闭费用
  // 展示意味着不希望普通用户感知到费用体系，这条警告同样应隐藏。
  const showPerMessageCost = useBillingStore(s => s.showPerMessageCost)

  const percent = useMemo(() => {
    if (!contextWindow || contextWindow <= 0) return 0
    return Math.min(100, Math.round((contextTokens / contextWindow) * 100))
  }, [contextTokens, contextWindow])

  const colors = getColorScheme(percent)

  // SVG 圆环参数（细环 + 小尺寸，默认低调灰度，避免「用量数字」常驻造成焦虑）
  const strokeWidth = 1.5
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const dashOffset = circumference - (percent / 100) * circumference

  const tooltipStyle = useMemo(() => {
    if (!showTooltip || !ringRef.current) return undefined
    const rect = ringRef.current.getBoundingClientRect()
    return {
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    } as React.CSSProperties
  }, [showTooltip])

  /** 圆环进度色：仅灰阶，略随占用加深，不做高饱和强调 */
  // 最深一档（≥85%）用满色 stroke-muted-foreground，与左侧工具栏图标按钮颜色一致；
  // 低占用仍保持低调浅灰，避免常驻造成用量焦虑。
  const ringProgressClass =
    percent >= 85
      ? 'stroke-muted-foreground'
      : percent >= 65
        ? 'stroke-muted-foreground/55'
        : 'stroke-muted-foreground/35'

  // 不显示条件：无上下文窗口（须放在 hooks 之后）。
  // contextTokens=0（全新 / 空会话）仍渲染一个 0% 的低调空环作为「上下文进度指示器」，
  // 让指示器常驻、不随空会话消失（环本身极低调，不会造成用量焦虑）。
  if (!contextWindow) return null

  // 临近上限时给一个能被人眼瞬间扫到的额外信号——14px 灰环阈值变化在视觉上
  // 几乎看不出来，配色保守的产品定调下需要文字 caption 来兜底告警。
  // ≥85%：旁边显示百分比数字（low-key text-warning/80）
  // ≥95%：再叠加一个细描边 + destructive 文字色，让用户在快爆时一眼看到
  const showInlinePercent = percent >= 85
  const isCritical = percent >= 95
  const captionClass = isCritical ? 'text-destructive/85' : 'text-warning/85'

  return (
    <div
      ref={ringRef}
      className="relative inline-flex shrink-0 items-center gap-1 cursor-default"
      aria-label={`会话上下文用量 ${percent}%，悬停查看详情`}
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <svg
        width={size}
        height={size}
        className="transform -rotate-90 text-muted-foreground"
        aria-hidden
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-muted-foreground/[0.12]"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
          className={cn(
            ringProgressClass,
            // ≥95% 给环本身加一点 destructive 灰阶上调，配合外层文字达到「明显
            // 但不刺眼」的告警力度（保持产品的低调审美——不变成红色按钮）
            isCritical && 'stroke-destructive/55',
            'transition-[stroke-dashoffset] duration-500 ease-out',
          )}
        />
      </svg>

      {showInlinePercent && (
        <span
          className={cn('text-caption tabular-nums leading-none', captionClass)}
          aria-hidden
        >
          {percent}%
        </span>
      )}

      {showTooltip && tooltipStyle && createPortal(
        // 用 Portal 渲染到 body：浮动输入卡片有 backdrop-blur，会成为 fixed 定位的
        // 包含块，导致基于视口坐标计算的 tooltip 偏移；脱离该祖先才能正确右对齐到指示器。
        <div
          className="fixed z-floating pointer-events-none"
          style={tooltipStyle}
        >
          {/*
            Tooltip 信息架构（2026-05-10 重排）：
            分两组，前后顺序按"用户决策需要的优先级"排——
              1. 「当前上下文」组：ring 的本职，回答"我快不快爆窗口"。
                 进度条 + 百分比 + 来源信号是这组的视觉核心。
              2. 「会话累计」组：计费总账，回答"我这场对话花了多少"。
                 输入/输出累计、缓存复用、扣费数都属于这组。
            两组之间一条粗一点的分隔线 + 显式分组标题，避免用户把
              "输入累计 757.1K" 和 "当前上下文 15" 当成同一维度的数字
              做无意义对比（这是 dogfood W4 反馈直接命中的痛点）。
          */}
          <div className={cn(
            'rounded-interactive px-3 py-2.5',
            OVERLAY_SURFACE_CLASS,
            'text-caption whitespace-nowrap min-w-[200px]'
          )}>
            <div className="flex items-baseline justify-between mb-2">
              <span className="font-medium text-foreground text-body">{t('tokenUsage.title')}</span>
              {showInlinePercent && (
                <span className={cn('text-caption', captionClass)}>
                  {isCritical
                    ? '上下文即将占满'
                    : `余量 ${Math.max(0, 100 - percent)}%`}
                </span>
              )}
            </div>

            {/* ─── 组 1：当前上下文（窗口压力视角） ─────────────── */}
            <div className="text-caption text-muted-foreground/55 mb-1">
              当前上下文
            </div>
            <div className="space-y-1 text-muted-foreground">
              <div className="flex justify-between gap-4 font-medium">
                <span>{t('tokenUsage.current')}</span>
                <span className={cn('tabular-nums', colors.twText)}>{formatTokens(contextTokens)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('tokenUsage.windowLimit')}</span>
                <span className="text-foreground tabular-nums">{formatTokens(contextWindow)}</span>
              </div>
            </div>
            <div className="mt-2 h-1.5 w-full rounded-full bg-muted/25 overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', colors.twBg)}
                style={{ width: `${percent}%` }}
              />
            </div>
            <div className="mt-1 text-caption text-muted-foreground/60 text-right">
              {percent}% 已占用
            </div>
            {/* 来源/置信度小字：turn_accum = 老会话靠 turn 累加估算（可能偏高 2-3x） */}
            {contextSource === 'turn_accum' && (
              <div className="mt-0.5 text-caption text-muted-foreground/55 text-right italic">
                基于历史 turn 累加估算（可能偏高）
              </div>
            )}
            {contextSource === 'post_compact' && (
              <div className="mt-0.5 text-caption text-muted-foreground/55 text-right italic">
                压缩后即时估算，下次回复后校准为真实值
              </div>
            )}

            {/* ─── 组 2：会话累计（计费/总账视角） ─────────────── */}
            <div className="border-t border-border/30 my-2.5" />
            <div className="text-caption text-muted-foreground/55 mb-1">
              会话累计 · 不参与窗口占用
            </div>
            <div className="space-y-1 text-muted-foreground">
              <div className="flex justify-between gap-4">
                <span>{t('tokenUsage.inputTotal')}</span>
                <span className="text-foreground tabular-nums">{formatTokens(inputTokens)}</span>
              </div>
              <div className="flex justify-between gap-4">
                <span>{t('tokenUsage.outputTotal')}</span>
                <span className="text-foreground tabular-nums">{formatTokens(outputTokens)}</span>
              </div>
              {hasCacheReadTokens === true && (
                <div className="flex justify-between gap-4">
                  <span>{t('tokenUsage.cacheHit')}</span>
                  <span className="text-foreground tabular-nums">{formatTokens(cacheReadTokens ?? 0)}</span>
                </div>
              )}
              {!!reasoningTokens && reasoningTokens > 0 && (
                <div className="flex justify-between gap-4">
                  <span>{t('tokenUsage.reasoning')}</span>
                  <span className="text-foreground tabular-nums">{formatTokens(reasoningTokens)}</span>
                </div>
              )}
              {!!compactInputTokens && compactInputTokens > 0 && (
                <div className="flex justify-between gap-4">
                  <span>{t('tokenUsage.autoCompacted')}</span>
                  <span className="text-foreground tabular-nums">{formatTokens(compactInputTokens)}</span>
                </div>
              )}
              {showPerMessageCost && (isByok ? (
                <>
                  <div className="flex justify-between gap-4">
                    <span>{t('tokenUsage.billing')}</span>
                    <span className="text-foreground tabular-nums">{t('tokenUsage.byok')}</span>
                  </div>
                  {hasMixedBilling && creditsConsumed != null && creditsConsumed > 0 && (
                    <div className="flex justify-between gap-4">
                      <span>{t('tokenUsage.historicalCost')}</span>
                      <span className="text-foreground tabular-nums">{formatCreditsAuto(creditsConsumed)} credits</span>
                    </div>
                  )}
                </>
              ) : creditsConsumed != null && creditsConsumed > 0 ? (
                <div className="flex justify-between gap-4">
                  <span>{t('tokenUsage.consumed')}</span>
                  <span className="text-foreground tabular-nums">{formatCreditsAuto(creditsConsumed)} credits</span>
                </div>
              ) : estimatedCost != null && estimatedCost > 0 ? (
                <div className="flex justify-between gap-4">
                  <span>{t('tokenUsage.estimatedCost')}</span>
                  <span className="text-foreground tabular-nums">≈ {formatCreditsAuto(estimatedCost)} credits</span>
                </div>
              ) : null)}
            </div>

            {showPerMessageCost && chargeFailed && (
              <div className="mt-1.5 text-caption text-warning font-medium">
                ⚠ 部分费用计算失败
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
