import React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { ShinyText } from '../markdown/ShinyText'
import { STEP_ROW, TEXT_COLOR } from '../registry/chatDesignTokens'
import { SubagentOrchestrationIcon } from '../subagent/SubagentOrchestrationIcon'
import type { SubagentCheckStatus } from './toolUseBlockViewLogic'

export interface SubagentCheckDisplayItem {
  childId: string | null
  label?: string
  status?: SubagentCheckStatus
}

const ERROR_STATUSES = new Set<SubagentCheckStatus>(['failed', 'not_found'])

function visibleItems(
  items: readonly SubagentCheckDisplayItem[],
): SubagentCheckDisplayItem[] {
  return items.filter((item) => item.status !== 'already_checked')
}

function statusKey(status: SubagentCheckStatus | undefined): string {
  switch (status) {
    case 'queued': return 'queued'
    case 'running': return 'running'
    case 'completed': return 'completed'
    case 'failed': return 'failed'
    case 'cancelled': return 'cancelled'
    case 'orphaned': return 'orphaned'
    case 'not_found': return 'notFound'
    case 'already_checked': return 'alreadyChecked'
    case 'checking':
    default:
      return 'checked'
  }
}

function singleLabel(
  item: SubagentCheckDisplayItem,
  t: ReturnType<typeof useTranslation<'chat'>>['t'],
): string {
  const key = statusKey(item.status)
  if (!item.label) return t(`subagent.check.${key}`, { defaultValue: '已查看子 Agent 状态' })

  const defaults: Record<string, string> = {
    checked: `已查看「${item.label}」状态`,
    queued: `已查看「${item.label}」状态 · 查询时排队中`,
    running: `已查看「${item.label}」状态 · 查询时运行中`,
    completed: `已查看「${item.label}」状态 · 已完成`,
    failed: `已查看「${item.label}」状态 · 已失败`,
    cancelled: `已查看「${item.label}」状态 · 已取消`,
    orphaned: `已查看「${item.label}」状态 · 状态待确认`,
    notFound: `未找到「${item.label}」`,
    alreadyChecked: `已忽略「${item.label}」的重复状态查询`,
  }
  return t(`subagent.check.named.${key}`, {
    label: item.label,
    defaultValue: defaults[key] ?? defaults.checked,
  })
}

function batchLabel(
  items: readonly SubagentCheckDisplayItem[],
  t: ReturnType<typeof useTranslation<'chat'>>['t'],
): string {
  const statuses = items.map((item) => item.status).filter(Boolean)
  if (statuses.length !== items.length) {
    return t('subagent.check.batch.checked', {
      count: items.length,
      defaultValue: `已查看 ${items.length} 个子 Agent 状态`,
    })
  }
  const first = statuses[0]
  const sameStatus = statuses.every((status) => status === first)
  if (!sameStatus) {
    return t('subagent.check.batch.mixed', {
      count: items.length,
      defaultValue: `已查看 ${items.length} 个子 Agent 状态 · 查询结果各异`,
    })
  }
  const key = statusKey(first)
  const defaults: Record<string, string> = {
    checked: `已查看 ${items.length} 个子 Agent 状态`,
    queued: `已查看 ${items.length} 个子 Agent 状态 · 查询时均在排队`,
    running: `已查看 ${items.length} 个子 Agent 状态 · 查询时均在运行`,
    completed: `已查看 ${items.length} 个子 Agent 状态 · 均已完成`,
    failed: `已查看 ${items.length} 个子 Agent 状态 · 均已失败`,
    cancelled: `已查看 ${items.length} 个子 Agent 状态 · 均已取消`,
    orphaned: `已查看 ${items.length} 个子 Agent 状态 · 状态均待确认`,
    notFound: `未找到这 ${items.length} 个子 Agent`,
    alreadyChecked: `已忽略本轮 ${items.length} 次重复状态查询`,
  }
  return t(`subagent.check.batch.${key}`, {
    count: items.length,
    defaultValue: defaults[key] ?? defaults.checked,
  })
}

function hasCheckError(
  items: readonly SubagentCheckDisplayItem[],
  hasError: boolean,
): boolean {
  if (hasError) return true
  return items.some((item) => item.status != null && ERROR_STATUSES.has(item.status))
}

function checkRowState(
  items: readonly SubagentCheckDisplayItem[],
  isChecking: boolean,
  errorTone: boolean,
): string {
  if (isChecking) return 'checking'
  if (items.length > 1) {
    const statuses = items.map((item) => item.status).filter(Boolean)
    if (statuses.length !== items.length) return errorTone ? 'failed' : 'checked'
    return statuses.every((status) => status === statuses[0]) ? statuses[0]! : 'mixed'
  }
  return items[0]?.status ?? (errorTone ? 'failed' : 'checked')
}

function checkingLabel(
  items: readonly SubagentCheckDisplayItem[],
  t: ReturnType<typeof useTranslation<'chat'>>['t'],
): string {
  if (items.length > 1) {
    return t('subagent.check.batch.checking', {
      count: items.length,
      defaultValue: `正在查看 ${items.length} 个子 Agent 状态`,
    })
  }
  const label = items[0]?.label
  if (label) {
    return t('subagent.check.named.checking', {
      label,
      defaultValue: `正在查看「${label}」状态`,
    })
  }
  return t('subagent.check.checking', { defaultValue: '正在查看子 Agent 状态' })
}

export const SubagentCheckStatusRow: React.FC<{
  items: readonly SubagentCheckDisplayItem[]
  isChecking: boolean
  hasError?: boolean
}> = ({ items, isChecking, hasError = false }) => {
  const { t } = useTranslation('chat')
  const displayItems = visibleItems(items)
  if (displayItems.length === 0) return null
  const isBatch = displayItems.length > 1
  const errorTone = hasCheckError(displayItems, hasError)
  const label = isBatch ? batchLabel(displayItems, t) : singleLabel(displayItems[0] ?? { childId: null }, t)
  const childIds = displayItems.map((item) => item.childId).filter(Boolean).join(',')
  const state = checkRowState(displayItems, isChecking, errorTone)
  const content = isChecking ? (
    <ShinyText className={STEP_ROW.label}>{checkingLabel(displayItems, t)}</ShinyText>
  ) : (
    <span className={cn(STEP_ROW.label, errorTone && TEXT_COLOR.errorSoft)}>{label}</span>
  )

  return (
    <div
      className={STEP_ROW.inline}
      data-testid={isBatch ? 'block-subagent-check-group' : 'block-subagent-check'}
      data-count={displayItems.length}
      data-child-id={isBatch ? undefined : displayItems[0]?.childId ?? undefined}
      data-child-ids={isBatch ? childIds : undefined}
      data-label={isBatch ? undefined : displayItems[0]?.label}
      data-state={state}
    >
      <SubagentOrchestrationIcon className={errorTone ? TEXT_COLOR.errorSoft : STEP_ROW.icon} />
      {content}
    </div>
  )
}
SubagentCheckStatusRow.displayName = 'SubagentCheckStatusRow'
