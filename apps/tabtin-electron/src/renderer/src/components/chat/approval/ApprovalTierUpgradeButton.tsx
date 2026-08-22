/**
 * ApprovalTierUpgradeButton — 审批卡片就地升档按钮
 *
 * 产品语义：审批弹卡是「以后都别再问我」诉求最强的现场。按当前会话生效审批档
 * 给出下一档的快捷出口：
 *   请求批准 → 「自动通过」；自动通过 → 「全部允许」；全部允许 → 不渲染。
 *
 * 点击行为（锁定口径与 ApprovalGrantSection 的三档选项一致）：
 *   - 超出 Agent 已授权上限（approval_grant）→ 先 ConfirmDialog 二次确认，
 *     确认后抬高 grant 再写会话档（与 ApprovalGrantSection 同一套规则）；
 *   - 未超上限 → 直接写会话档；
 *   - 成功后回调 onUpgraded()，由审批卡片放行当前这批操作（等价「这次允许」）。
 *
 * 锁定态（与设置面板同款 badge，不藏按钮——能力入口保持可见）：
 *   - 组织未开放宽松审批 → 禁用 + 「组织未开放」badge；
 *   - 需抬 grant 但无 Agent 管理权限 → 禁用 + 「需管理员授权」badge。
 *
 * 不渲染的场景：PMO 群会话（固定请求批准）；已是全部允许（没有下一档）。
 */

import React, { useCallback, useState } from 'react'
import { Shield, ShieldAlert, type LucideIcon } from 'lucide-react'
import { ConfirmDialog } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { useAuthStore } from '@stores/useAuthStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { canEditAgentSettings } from '@/hooks/useCanEditAgentSettings'
import {
  effectiveCanEditAgentSettings,
  useSpaceSettingsEditGuard,
} from '@components/space-settings/hooks/useSpaceSettingsEditGuard'
import { useApprovalGrantControl } from '@components/space-settings/useApprovalGrantControl'
import { approvalModeRank, type ApprovalModeName } from '@/stores/chat/shared/types'

const NEXT_TIER: Partial<Record<ApprovalModeName, ApprovalModeName>> = {
  always_ask: 'auto',
  auto: 'full_access',
}

// 图标与 ApprovalGrantSection 的 GRANT_TIER_ICON 对齐（auto=Shield / full_access=ShieldAlert），
// 避免同一档在审批卡按钮与浮层/设置里显示不同图标。
const TIER_ICON: Record<'auto' | 'full_access', LucideIcon> = {
  auto: Shield,
  full_access: ShieldAlert,
}

interface ApprovalTierUpgradeButtonProps {
  spaceId: string | null | undefined
  sessionId: string | null
  disabled?: boolean
  /** 升档写入成功后回调；审批卡片用它放行当前 batch。 */
  onUpgraded: () => void
  className?: string
}

export const ApprovalTierUpgradeButton: React.FC<ApprovalTierUpgradeButtonProps> = ({
  spaceId,
  sessionId,
  disabled = false,
  onUpgraded,
  className,
}) => {
  const { t } = useTranslation('chat')
  const { t: tSpace } = useTranslation('space')
  const {
    saving,
    currentGrant,
    approvalContext,
    currentConversationApproval,
    applyConversationApproval,
    persistGrant,
    // 审批卡片场景：不每卡 force fetch，读缓存即可（见 hook 内 refreshOnMount 说明）
  } = useApprovalGrantControl(spaceId ?? '', sessionId, { refreshOnMount: false })

  // canManage 口径与 ApprovalGrantPopover 一致：组织角色（owner 兜底）+ 远程查看守卫。
  const currentUserRole = useOrganizationStore(s => s.currentUserRole)
  const selectedOrganization = useOrganizationStore(s => s.selectedOrganization)
  const user = useAuthStore(s => s.user)
  const isOwner = !!(user && selectedOrganization && user.id === selectedOrganization.owner_id)
  const effectiveRole = currentUserRole ?? (isOwner ? 'owner' : null)
  const settingsEditGuard = useSpaceSettingsEditGuard(spaceId)
  const canManage = effectiveCanEditAgentSettings(
    canEditAgentSettings(effectiveRole),
    settingsEditGuard,
  )

  const [confirming, setConfirming] = useState(false)

  const nextTier = NEXT_TIER[currentConversationApproval] ?? null
  const needsGrantRaise = nextTier != null
    && approvalModeRank(nextTier) > approvalModeRank(currentGrant)
  // 锁定口径与 ApprovalGrantSection 的三档选项一致：组织未开放优先展示
  const orgLocked = !approvalContext.allowYolo
  const manageLocked = !orgLocked && needsGrantRaise && !canManage
  const locked = orgLocked || manageLocked

  const applyUpgrade = useCallback((tier: ApprovalModeName) => {
    applyConversationApproval(tier)
    onUpgraded()
  }, [applyConversationApproval, onUpgraded])

  const handleClick = useCallback(() => {
    if (!nextTier) return
    if (needsGrantRaise) {
      setConfirming(true)
      return
    }
    applyUpgrade(nextTier)
  }, [applyUpgrade, needsGrantRaise, nextTier])

  if (!spaceId || !nextTier) return null
  if (approvalContext.isGroupSpace) return null

  const Icon = TIER_ICON[nextTier as 'auto' | 'full_access']
  const label = nextTier === 'auto'
    ? t('approval.upgradeToAuto', { defaultValue: '自动通过' })
    : t('approval.upgradeToFullAccess', { defaultValue: '全部允许' })

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled || saving || locked}
        data-testid="approval-tier-upgrade"
        data-next-tier={nextTier}
        data-org-locked={orgLocked ? 'true' : undefined}
        data-manage-locked={manageLocked ? 'true' : undefined}
        className={cn(
          'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 h-7',
          'text-body transition-colors',
          'border border-border/60 bg-background text-foreground/80',
          'hover:bg-muted/40 hover:text-foreground disabled:hover:bg-background',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          className,
        )}
        title={locked
          ? (orgLocked
              ? tSpace('security.approvalGrantOrgLocked', {
                  defaultValue: '组织未开放宽松审批，请联系组织所有者在组织设置中开启',
                })
              : tSpace('security.approvalGrantManageRequired', {
                  defaultValue: '此档位需要 Agent 管理权限授权后才能使用',
                }))
          : t('approval.upgradeHint', {
              defaultValue: '升级本对话的审批策略并允许这批操作',
            })}
      >
        <Icon className={cn(
          'h-3.5 w-3.5',
          nextTier === 'auto' ? 'text-warning' : 'text-destructive',
        )} />
        {label}
        {/* 锁定原因 badge：chat 设计语言 point-only——不上色面，仅文字色承担 */}
        {orgLocked && (
          <span className="shrink-0 text-caption text-warning/80">
            {tSpace('security.approvalGrantOrgBadge', { defaultValue: '组织未开放' })}
          </span>
        )}
        {manageLocked && (
          <span className="shrink-0 text-caption text-muted-foreground/80">
            {tSpace('security.approvalGrantManageBadge', { defaultValue: '需管理员授权' })}
          </span>
        )}
      </button>

      {/* 升档超出 Agent 授权上限时的二次确认（与 ApprovalGrantSection 同口径） */}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={tSpace('security.approvalGrantConfirmTitle', {
          tier: tSpace(`security.approvalGrant.${nextTier}.name`),
          defaultValue: '授权「{{tier}}」？',
        })}
        description={nextTier === 'full_access'
          ? tSpace('security.approvalGrantConfirmBodyFullAccess', {
              defaultValue: '授权后，当前对话将按「全部允许」执行：无需授权直接执行，仅灾难级命令被拦截。此 Agent 会记住该授权上限，之后可在此处收回。',
            })
          : tSpace('security.approvalGrantConfirmBodyAuto', {
              defaultValue: '授权后，当前对话将按「自动通过」执行：常规操作自动批准，仅高风险操作仍会询问。此 Agent 会记住该授权上限，之后可在此处收回。',
            })}
        variant="destructive"
        onConfirm={() => {
          setConfirming(false)
          void persistGrant(nextTier).then((ok) => {
            if (ok) applyUpgrade(nextTier)
          })
        }}
      />
    </>
  )
}
