/**
 * SystemNoticeBanner — 系统通知 inline 卡片（W4.5-A3-followup 修复）。
 *
 * 业务背景：
 * 多条 SYSTEM_NOTICE 路径（context_truncated / tool_failure_notice /
 * tool_repetition_notice / subagent_spawn_blocked / model_override /
 * model_fallback / tool_timeout / subagent_hitl_required /
 * speaker_push_message ...）走 `systemHandler` / `subagentHandler` push
 * 进 `agentStepsBySessionId`，但 W4c 退役 MessageSteps / AgentSteps 组件
 * 之后 `components/chat/` 下**0 处订阅**该 store——这些 notice 数据已
 * 持久化但用户看不见（实证 grep `useChatRuntimeStore.*agentStepsBySessionId`
 * 在 components/ 下 0 命中）。
 *
 * 修复思路：
 *   - 订阅 `agentStepsBySessionId[sessionId]`，filter `type === 'system_notice'`
 *     → 用户能感知 ≥9 条 SYSTEM_NOTICE 路径
 *   - 视觉风格 sibling 于 `CapabilityBanners`（rounded-xl border bg/5），
 *     不做新的复杂 UI；位置在 ChatContent 顶部 banner 区
 *   - noticeType 决定 icon + 色调（warning vs info），但**文案直接用 step.title /
 *     step.detail**（已被 systemHandler i18n 化），未知 noticeType 走通用文案
 *     fallback 防止漏渲染
 *   - dismiss 用 sessionStorage 持久化（session 内 dismiss 后不重新出现，
 *     重启页面后清空——避免"永久失踪"），不污染 useChatRuntimeStore
 *
 * 条数：渲染全部未 dismiss 的 system_notice（ 前曾限 3 条，现由外层
 * ChatNoticeStack 统一折叠，计数须与真实条数一致，此处不再截断）。
 *
 * 与 `agentStepsBySessionId` 其他 type 的关系：
 *   - 'tool_start' / 'tool_end' → 由 BlockTimeline / ToolUseBlockView 渲染
 *   - 'thinking' / 'generating' / 'context_loading' / 'compaction' / 'lifecycle'
 *     → 当前 BlockTimeline 不渲染，但本组件**只**关心 'system_notice'，
 *     其他 type 的渲染由后续 Wave 单独决策
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Info, AlertTriangle, AlertCircle } from 'lucide-react'
import { Button } from '@components/ui'
import { cn } from '@utils/cn'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import type { AgentStep } from '@/stores/chat/shared/types'
import { CHAT_PAGE_GUTTER } from '../registry/chatDesignTokens'

interface SystemNoticeBannerProps {
  sessionId: string | null
  /**
   * 当前聊天所属 Space。执行限制类通知（credits/tokens 超限）用它打开
   * 「工作空间设置 → 执行限制」面板；缺省时不渲染「去设置」按钮。
   */
  spaceId?: string | null
  /** 嵌入式布局时左侧 paddingLeft 缩进，与 ModeBanner / CapabilityBanners 对齐。 */
  compactLeft?: boolean
}

/**
 * 视觉权重映射 —— 按"用户应该警觉的程度"分三档：
 *   - error：执行已失败 / 工具超时 / 工具反复同问题（需要用户关注）
 *   - warning：等待用户审批 / 失败 streak nudge（产品阻塞）
 *   - info：信息性告知（已自动处理，可忽略）
 *
 * 未知 noticeType → info（保守降级）。
 */
type Severity = 'error' | 'warning' | 'info'

const NOTICE_SEVERITY: Record<string, Severity> = {
  tool_timeout: 'error',
  tool_failure_nudge: 'warning',
  tool_repetition_nudge: 'warning',
  subagent_hitl_required: 'warning',
  tool_failure_notice: 'info',
  tool_repetition_notice: 'info',
  subagent_spawn_blocked: 'warning',
  context_truncated: 'info',
  model_override: 'info',
  model_fallback: 'info',
  speaker_push_message: 'info',
  credits_exceeded: 'warning',
  tokens_exceeded: 'warning',
  force_final: 'warning',
}

/**
 * 运行守卫（budget guard）类通知 —— runtime `forceFinalMessages()` 的三种
 * notice_type。文案都指向「工作空间设置 → 执行限制」，附「去设置」按钮让用户
 * 一键直达（免去按文案手动找路径）。
 */
const EXECUTION_LIMIT_NOTICE_TYPES = new Set([
  'credits_exceeded',
  'tokens_exceeded',
  'force_final',
])

const SEVERITY_THEME: Record<Severity, {
  bgClass: string
  textClass: string
  iconClass: string
  Icon: React.ComponentType<{ className?: string }>
}> = {
  error: {
    bgClass: 'bg-destructive/5',
    textClass: 'text-destructive',
    iconClass: 'text-destructive',
    Icon: AlertCircle,
  },
  warning: {
    bgClass: 'bg-warning/5',
    textClass: 'text-warning',
    iconClass: 'text-warning',
    Icon: AlertTriangle,
  },
  info: {
    bgClass: 'bg-info/5',
    textClass: 'text-foreground/80',
    iconClass: 'text-info',
    Icon: Info,
  },
}

const DISMISSED_STORAGE_KEY_PREFIX = 'tabtin:systemNoticeBanner:dismissed:'

function dismissedStorageKey(sessionId: string): string {
  return `${DISMISSED_STORAGE_KEY_PREFIX}${sessionId}`
}

function readDismissed(sessionId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(dismissedStorageKey(sessionId))
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    if (Array.isArray(arr)) {
      return new Set(arr.filter((x): x is string => typeof x === 'string'))
    }
  } catch {
    // sessionStorage 不可用 / JSON 损坏 → 返回空 Set，不报错
  }
  return new Set()
}

function persistDismissed(sessionId: string, dismissed: Set<string>): void {
  try {
    sessionStorage.setItem(
      dismissedStorageKey(sessionId),
      JSON.stringify(Array.from(dismissed)),
    )
  } catch {
    // sessionStorage 不可用 → silent ignore；下次组件 mount 会重新尝试
  }
}

const EMPTY_STEPS: readonly AgentStep[] = Object.freeze([])

interface SystemNoticeCardProps {
  step: AgentStep
  onDismiss: (id: string) => void
  /** 执行限制类通知的「去设置」跳转；spaceId 缺省时为 undefined（不渲染按钮）。 */
  onOpenExecutionLimits?: () => void
}

const SystemNoticeCard: React.FC<SystemNoticeCardProps> = React.memo(({
  step,
  onDismiss,
  onOpenExecutionLimits,
}) => {
  const { t } = useTranslation('chat')

  const noticeType = step.noticeType ?? ''
  const severity: Severity = NOTICE_SEVERITY[noticeType] ?? 'info'
  const theme = SEVERITY_THEME[severity]
  const Icon = theme.Icon
  const showExecutionLimitsAction =
    EXECUTION_LIMIT_NOTICE_TYPES.has(noticeType) && !!onOpenExecutionLimits

  // 文案策略：systemHandler / subagentHandler 写入 step.title / step.detail 时
  // 已经走过 i18next 本地化（中文路径走 chat.systemNotice.*、英文路径走对应
  // en-US 翻译）。本卡片直接展示 step.title 即可，对未知 noticeType（譬如
  // daemon 未来引入新 notice_type 而 systemHandler 没接的灰度路径）回落到
  // step.title（systemHandler 已用 rawContent 作为 fallback）+ 通用"系统通知"
  // 前缀标签——让用户至少看见"有事发生"而不是 silent drop。
  const displayTitle = step.title || t('chat:systemNotice.genericNotice', { defaultValue: '系统通知' })
  const displayDetail = step.detail && step.detail !== step.title ? step.detail : undefined

  const handleDismiss = useCallback(() => {
    onDismiss(step.id)
  }, [step.id, onDismiss])

  return (
    <div
      className={cn('rounded-xl px-3 py-2', theme.bgClass)}
      role="status"
      aria-live="polite"
      data-testid="system-notice-banner"
      data-notice-type={noticeType || 'unknown'}
      data-severity={severity}
      data-chat-notice
    >
      <div className="flex items-start gap-2">
        <Icon className={cn('h-4 w-4 shrink-0 mt-0.5', theme.iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn('text-body leading-snug break-words', theme.textClass)}>
            {displayTitle}
            {/* 按钮紧跟文字排（inline），横幅窄时随文字换行，不撑出独立右列 */}
            {showExecutionLimitsAction && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onOpenExecutionLimits}
                className="ml-1.5 inline-flex h-5 px-1.5 align-baseline text-caption"
                data-testid="system-notice-banner-open-limits"
              >
                {t('systemNotice.openExecutionLimits', { defaultValue: '设置' })}
              </Button>
            )}
          </p>
          {displayDetail && (
            <p className="mt-0.5 text-caption text-muted-foreground/80 break-words">
              {displayDetail}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground"
          aria-label={t('systemNotice.dismiss', { defaultValue: '关闭提示' })}
          data-testid="system-notice-banner-dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
})
SystemNoticeCard.displayName = 'SystemNoticeCard'

export const SystemNoticeBanner: React.FC<SystemNoticeBannerProps> = ({
  sessionId,
  spaceId = null,
  compactLeft = false,
}) => {
  const allSteps = useChatRuntimeStore(s =>
    sessionId ? (s.agentStepsBySessionId[sessionId] ?? EMPTY_STEPS) : EMPTY_STEPS,
  )
  const openSettingsSheet = useAgentSettingsSheetStore(s => s.open)

  const handleOpenExecutionLimits = useMemo(() => {
    if (!spaceId) return undefined
    return () => openSettingsSheet('execution-limits', spaceId)
  }, [spaceId, openSettingsSheet])

  // Session 切换时**重置** dismissed —— 从 sessionStorage 读对应 session 的状态。
  // 这避免 session A 的 dismissed 影响 session B 的展示。
  const [dismissed, setDismissed] = useState<Set<string>>(() =>
    sessionId ? readDismissed(sessionId) : new Set(),
  )

  useEffect(() => {
    if (sessionId) {
      setDismissed(readDismissed(sessionId))
    } else {
      setDismissed(new Set())
    }
  }, [sessionId])

  const visibleNotices = useMemo(() => {
    return allSteps.filter(step => step.type === 'system_notice' && !dismissed.has(step.id))
  }, [allSteps, dismissed])

  const handleDismiss = useCallback(
    (stepId: string) => {
      if (!sessionId) return
      setDismissed(prev => {
        if (prev.has(stepId)) return prev
        const next = new Set(prev)
        next.add(stepId)
        persistDismissed(sessionId, next)
        return next
      })
    },
    [sessionId],
  )

  if (!sessionId || visibleNotices.length === 0) return null

  return (
    <div
      className={cn(
        'flex-shrink-0 space-y-1.5 mb-2',
        compactLeft ? CHAT_PAGE_GUTTER.compact.content : CHAT_PAGE_GUTTER.panel.margin,
      )}
      data-testid="system-notice-banner-host"
    >
      {visibleNotices.map(step => (
        <SystemNoticeCard
          key={step.id}
          step={step}
          onDismiss={handleDismiss}
          onOpenExecutionLimits={handleOpenExecutionLimits}
        />
      ))}
    </div>
  )
}
