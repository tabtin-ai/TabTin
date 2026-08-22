/**
 * MessageCostLabel — assistant 消息的单条费用标注
 *
 * 渲染规则（PRD-04 Wave 5 任务 3/5）：
 *  - 正常扣费（credits_consumed > 0）：展示"≈ X 点券"，hover 显示 token 明细
 *  - 扣费失败（charge_failed=true）：warning 色提示"费用暂未出账"——不是事故，是异步重试
 *  - BYOK 免计费（is_byok=true 且无 token usage）：展示"自备密钥 · 不扣点券"
 *  - 本机 / BYOK 用量（有 token usage 但 0 credits）：展示本次输入/输出 token，hover 显示缓存分项
 *  - 其他情况（向前兼容旧消息）：return null
 *
 * 所有情况都受 `useBillingStore.showPerMessageCost` 开关控制——若管理员未在
 * BillingRuntimeConfig 打开 show_per_message_cost，则对所有用户隐藏此标签。
 */

import React, { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { OVERLAY_SURFACE_CLASS } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { formatCreditsAuto } from '@/utils/formatBilling'
import { Coins, AlertTriangle, KeyRound, Gauge } from 'lucide-react'
import { useBillingStore } from '@/stores/useBillingStore'
import { useScopedEventListener } from '@hooks/spaceActivity'

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined
}

interface MessageCostLabelProps {
  metadata?: Record<string, unknown> | null
}

export const MessageCostLabel: React.FC<MessageCostLabelProps> = React.memo(({ metadata }) => {
  const { t } = useTranslation('chat')
  const [isHoverOpen, setIsHoverOpen] = useState(false)
  const [isPinnedOpen, setIsPinnedOpen] = useState(false)
  const detailId = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showPerMessageCost = useBillingStore((s) => s.showPerMessageCost)

  const credits = metadata?.credits_consumed as number | undefined
  const chargeFailed = metadata?.charge_failed === true
  const isByok = metadata?.is_byok === true

  const hasCredits = typeof credits === 'number' && credits > 0
  const inputTokens = readNonNegativeNumber(metadata?.last_input_tokens)
    ?? readNonNegativeNumber(metadata?.input_tokens)
    ?? 0
  const outputTokens = readNonNegativeNumber(metadata?.last_output_tokens)
    ?? (
      metadata?.last_input_tokens === undefined
        ? readNonNegativeNumber(metadata?.output_tokens)
        : undefined
    )
    ?? 0
  const cacheReadFromMetadata = readNonNegativeNumber(metadata?.last_cache_read_input_tokens)
    ?? readNonNegativeNumber(metadata?.cache_read_input_tokens)
  const cacheCreationFromMetadata = readNonNegativeNumber(metadata?.last_cache_creation_input_tokens)
    ?? readNonNegativeNumber(metadata?.cache_creation_input_tokens)
  const cacheReadInputTokens = cacheReadFromMetadata ?? 0
  const cacheCreationInputTokens = cacheCreationFromMetadata ?? 0
  const hasCacheReadField = cacheReadFromMetadata !== undefined
  const hasCacheCreationField = cacheCreationFromMetadata !== undefined
  const requestTokens = inputTokens + outputTokens
  const promptInputTokens = inputTokens + cacheReadInputTokens + cacheCreationInputTokens
  const hasTokenUsage = inputTokens > 0
    || outputTokens > 0
    || hasCacheReadField
    || hasCacheCreationField
  const showDetail = isHoverOpen || isPinnedOpen
  const documentTarget = typeof document === 'undefined' ? null : document

  const handleMouseEnter = () => {
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setIsHoverOpen(true), 300)
  }
  const handleMouseLeave = () => {
    clearTimeout(timerRef.current)
    setIsHoverOpen(false)
  }

  useEffect(() => {
    return () => clearTimeout(timerRef.current)
  }, [])

  useScopedEventListener<PointerEvent>(documentTarget, 'pointerdown', (event) => {
    if (rootRef.current?.contains(event.target as Node)) return
    setIsPinnedOpen(false)
    setIsHoverOpen(false)
  }, {
    enabled: isPinnedOpen,
  })

  useScopedEventListener<KeyboardEvent>(documentTarget, 'keydown', (event) => {
    if (event.key === 'Escape') {
      setIsPinnedOpen(false)
      setIsHoverOpen(false)
    }
  }, {
    enabled: showDetail,
  })

  // 不展示的情况：总开关关 / 既没有有效费用 也不是失败 也不是 BYOK 也没有 token usage（老消息）
  if (!showPerMessageCost) return null
  if (!hasCredits && !chargeFailed && !isByok && !hasTokenUsage) return null

  // 模式解析：优先级 charge_failed > 正常扣费 > token usage > 纯 BYOK 标记。
  // Codex/OpenAI usage 的 cache read 是输入侧拆分项，不额外计入主标签总量。
  const mode: 'failed' | 'byok' | 'charged' | 'usage' = chargeFailed
    ? 'failed'
    : hasCredits
      ? 'charged'
      : hasTokenUsage
        ? 'usage'
        : 'byok'

  // Review 反馈：charge_failed 用 destructive 红色过于醒目会引起用户焦虑
  // （以为"扣错钱"或"被多扣"）；降级到 warning 色并与 TokenUsageRing 底部的
  // ⚠ 警告保持一致的严重等级——提示用户"暂未出账"，不是"资金事故"。
  const wrapperClass = cn(
    'relative inline-flex items-center text-caption select-none',
    mode === 'failed'
      ? 'text-warning/90'
      : mode === 'byok'
        ? 'text-muted-foreground/80'
        : 'text-muted-foreground/60',
  )

  return (
    <span
      ref={rootRef}
      className={wrapperClass}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className={cn(
          'inline-flex items-center gap-0.5 rounded-md px-0.5 py-0.5',
          'transition-colors hover:bg-muted/30 hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        )}
        aria-label={t('messageCost.openDetails', { defaultValue: '查看费用详情' })}
        aria-expanded={showDetail}
        aria-controls={showDetail ? detailId : undefined}
        aria-describedby={showDetail ? detailId : undefined}
        onClick={() => {
          clearTimeout(timerRef.current)
          setIsHoverOpen(false)
          setIsPinnedOpen((open) => !open)
        }}
      >
        {mode === 'failed' && <AlertTriangle className="h-3 w-3" />}
        {mode === 'byok' && <KeyRound className="h-3 w-3" />}
        {mode === 'charged' && <Coins className="h-3 w-3" />}
        {mode === 'usage' && <Gauge className="h-3 w-3" />}
        <span>
          {mode === 'failed' && t('messageCost.chargeFailed', { defaultValue: '费用暂未出账' })}
          {mode === 'byok' && t('messageCost.byok', { defaultValue: '自备密钥 · 不扣 credits' })}
          {mode === 'charged' && credits != null && (
            <>≈ {formatCreditsAuto(credits)} {t('messageCost.unit')}</>
          )}
          {mode === 'usage' && t('messageCost.tokenUsage', {
            defaultValue: '{{countFormatted}} tokens',
            count: requestTokens,
            countFormatted: formatTokens(requestTokens),
          })}
        </span>
      </button>

      {showDetail && (
        <div
          id={detailId}
          role="tooltip"
          aria-label={t('messageCost.label')}
          className={cn(
            'absolute bottom-full left-0 mb-1.5 z-dropdown',
            'w-max max-w-[240px] rounded-interactive px-3 py-2',
            OVERLAY_SURFACE_CLASS,
            'text-caption',
            'animate-in fade-in-0 duration-150',
          )}
        >
          {mode === 'failed' && (
            <div className="text-warning mb-1">
              {t('messageCost.chargeFailedDetail', {
                defaultValue: '本条计费暂未出账，稍后会自动重试结算；不会重复扣 credits，以最终结算为准。',
              })}
            </div>
          )}
          {mode === 'byok' && (
            <div className="text-muted-foreground mb-1">
              {t('messageCost.byokDetail', {
                defaultValue: '你使用的是自带 API 密钥（BYOK），本条消息不从 TabTin 钱包扣 credits。',
              })}
            </div>
          )}
          {mode === 'usage' && isByok && (
            <div className="text-muted-foreground mb-1">
              {t('messageCost.byokDetail', {
                defaultValue: '你使用的是自带 API 密钥（BYOK），本条消息不从 TabTin 钱包扣 credits。',
              })}
            </div>
          )}
          {(inputTokens > 0 || outputTokens > 0 || hasCacheReadField || hasCacheCreationField) && (
            <div className="space-y-0.5">
              {(hasCacheReadField || hasCacheCreationField) && promptInputTokens > 0 && (
                <div>{t('messageCost.promptInputTokens', {
                  defaultValue: '本次输入：{{countFormatted}} tokens',
                  count: promptInputTokens,
                  countFormatted: formatTokens(promptInputTokens),
                })}</div>
              )}
              {!hasCacheReadField && !hasCacheCreationField && inputTokens > 0 && (
                <div>{t('messageCost.inputTokens', { count: inputTokens, countFormatted: formatTokens(inputTokens) })}</div>
              )}
              {hasCacheReadField && (
                <div>{t('messageCost.cacheReadInputTokens', {
                  defaultValue: '缓存命中：{{countFormatted}} tokens',
                  count: cacheReadInputTokens,
                  countFormatted: formatTokens(cacheReadInputTokens),
                })}</div>
              )}
              {hasCacheCreationField && (
                <div>{t('messageCost.cacheCreationInputTokens', {
                  defaultValue: '缓存写入：{{countFormatted}} tokens',
                  count: cacheCreationInputTokens,
                  countFormatted: formatTokens(cacheCreationInputTokens),
                })}</div>
              )}
              {(hasCacheReadField || hasCacheCreationField) && inputTokens > 0 && (
                <div>{t('messageCost.freshInputTokens', {
                  defaultValue: '新增输入：{{countFormatted}} tokens',
                  count: inputTokens,
                  countFormatted: formatTokens(inputTokens),
                })}</div>
              )}
              {outputTokens > 0 && (
                <div>{t('messageCost.outputTokens', { count: outputTokens, countFormatted: formatTokens(outputTokens) })}</div>
              )}
            </div>
          )}
          {mode === 'charged' && (
            <div className="mt-1 text-muted-foreground/60">
              {t('messageCost.disclaimer')}
            </div>
          )}
        </div>
      )}
    </span>
  )
})
MessageCostLabel.displayName = 'MessageCostLabel'
