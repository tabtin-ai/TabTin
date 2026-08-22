/**
 * HitlResourceLabel — HITL 审批面板里渲染「人类可读资源 label」的小组件（Wave A 启动包 A4）。
 *
 * 输入：CLI 调用的 `cli_spec`（PRD-v3 §5.1 第 1 项）。三种渲染状态：
 *
 * 1. **有 `resource_label`**：显示 label（如「产品三群」），主色 + 加粗，
 *    `title` 属性带原始 `resource` 便于鼠标悬停查看原 id；同时 `aria-label`
 *    把"资源 + label + 原 id"组合输出，供读屏器朗读完整信息。
 * 2. **无 `resource_label` 但有 `resource`**：灰显 raw id（`oc_xxx`）+ 中性
 *    「暂无法显示名称」提示（PRD §13.2 子 Agent 自决：fail-safe，不阻断用户决策；
 *     文案中性而非"无法解析"，避免用户误以为系统坏了）。
 * 3. **`cli_spec` 缺失或无 resource**：组件返回 null，由外层 ApprovalPanel 走原有渲染。
 *
 * 设计原则（消化 A4 题目要求 + AGENTS.md 设计规范）：
 * - 字号统一用 `text-caption`（与 ApprovalPanel 同档）
 * - 颜色用语义 token（`text-foreground` / `text-muted-foreground`），不硬编码
 * - 无图标：HITL 主面板已用 `ShieldAlert` 表态，本组件聚焦"展示资源"，不抢视觉
 * - 不依赖任何运行时数据源：纯展示组件，便于 RTL 测试
 * - **a11y**：每行通过 `aria-label` 把完整 raw id 暴露给读屏（A4 三视角 Review 反馈），
 *   触屏 / 视障用户即使无法 hover 也能拿到完整 id；保留 `<code>` 与 `title` 给视觉用户。
 */

import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import type { CliSpecForUI } from '@tabtin/chat-client'

interface HitlResourceLabelProps {
  cliSpec?: CliSpecForUI | null
  className?: string
}

export const HitlResourceLabel: React.FC<HitlResourceLabelProps> = ({
  cliSpec,
  className,
}) => {
  const { t } = useTranslation('chat')

  const resource = cliSpec?.resource
  const resourceLabel = cliSpec?.resource_label

  // a11y label：把完整信息组成一条朗读串，避免读屏器只读到截断后的文本
  const ariaLabel = useMemo(() => {
    const prefix = t('review.resourceLabel', { defaultValue: '资源' })
    if (resourceLabel && resource) return `${prefix}: ${resourceLabel} (${resource})`
    if (resourceLabel) return `${prefix}: ${resourceLabel}`
    if (resource) {
      const unresolved = t('review.resourceLabelUnresolvedTip', {
        defaultValue: '已显示原始 ID；不影响你拒绝或允许此操作',
      })
      return `${prefix}: ${resource} — ${unresolved}`
    }
    return undefined
  }, [t, resource, resourceLabel])

  if (!cliSpec) return null
  if (!resource && !resourceLabel) return null

  if (resourceLabel) {
    return (
      <span
        className={cn(
          'inline-flex max-w-full min-w-0 items-center gap-1 text-caption',
          className,
        )}
        data-testid="hitl-resource-label"
        data-resource-state="resolved"
        aria-label={ariaLabel}
      >
        <span className="text-muted-foreground shrink-0" aria-hidden="true">
          {t('review.resourceLabel', { defaultValue: '资源' })}
        </span>
        <span
          className="text-foreground font-medium truncate"
          title={resource ?? undefined}
          aria-hidden="true"
        >
          {resourceLabel}
        </span>
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex max-w-full min-w-0 items-center gap-1 text-caption',
        className,
      )}
      data-testid="hitl-resource-label"
      data-resource-state="raw-id"
      aria-label={ariaLabel}
    >
      <span className="text-muted-foreground shrink-0" aria-hidden="true">
        {t('review.resourceLabel', { defaultValue: '资源' })}
      </span>
      <code
        className="text-muted-foreground/80 font-mono truncate"
        title={resource ?? undefined}
        aria-hidden="true"
      >
        {resource}
      </code>
      <span
        className="text-muted-foreground/60 shrink-0"
        title={t('review.resourceLabelUnresolvedTip', {
          defaultValue: '已显示原始 ID；不影响你拒绝或允许此操作',
        })}
        aria-hidden="true"
      >
        {t('review.resourceLabelUnresolved', { defaultValue: '（暂无法显示名称）' })}
      </span>
    </span>
  )
}

export default HitlResourceLabel
