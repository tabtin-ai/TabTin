/**
 * ApprovalGrantSection — 「审批权限授权」三档选择（共享区块）
 *
 * 从 AgentSecurityPanel 的板块 A 抽出，两处复用、规则单源：
 * - 「授权策略」抽屉 / Space 设置（AgentSecurityPanel）
 * - 聊天 composer 的轻量浮层（ApprovalGrantPopover）
 *
 * 交互规则（ /  三档审批策略）：
 * - 升/降档改的是 Workspace `approval_grant`；有会话时再同步 session 覆盖；
 * - 新任务草稿无 session 时仍可调档（只持久化 grant；生效档跟随 grant）；
 * - 升档（超过已授权上限）先 ConfirmDialog 二次确认；降档即时生效；
 * - 三种锁定态：组织未开放宽松审批 / PMO 固定请求权限 / 无管理权限不可升档。
 */

import React, { useCallback, useState } from 'react'
import { Shield, ShieldAlert, ShieldCheck, Check, type LucideIcon } from 'lucide-react'
import { ConfirmDialog, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { SETTINGS_HINT } from '@components/settings/settingsUi'
import { cn } from '@utils/cn'
import {
  APPROVAL_MODE_NAMES,
  approvalModeRank,
  type ApprovalModeName,
} from '@/stores/chat/shared/types'
import { useChatStore } from '@stores/chat/useChatStore'
import { useApprovalGrantControl } from './useApprovalGrantControl'

const GRANT_TIER_ICON: Record<ApprovalModeName, LucideIcon> = {
  always_ask: ShieldCheck,
  auto: Shield,
  full_access: ShieldAlert,
}

export interface ApprovalGrantSectionProps {
  spaceId: string
  canManage?: boolean
  /** 审批档选择作用的目标会话；缺省时按 spaceId 回退到该 Space 当前会话。 */
  sessionId?: string | null
  /** 无边框形态（浮层壳自带留白 / 边框时用）；默认渲染圆角边框卡片。 */
  frameless?: boolean
  /**
   * 升档二次确认框开合回调。
   * 浮层宿主用它在确认框打开期间暂停「点外部关闭」，避免点确认按钮时浮层自关。
   */
  onConfirmOpenChange?: (open: boolean) => void
  /**
   * 升档确认框的 Portal 容器。缺省走 OverlayContainerContext（抽屉内 scoped 展示）；
   * 浮层宿主传 null 强制全局层——浮层自身 fixed 在 body 上，scoped 容器会被它盖住。
   */
  confirmDialogContainer?: HTMLElement | null
}

export const ApprovalGrantSection: React.FC<ApprovalGrantSectionProps> = ({
  spaceId,
  canManage = true,
  sessionId = null,
  frameless = false,
  onConfirmOpenChange,
  confirmDialogContainer,
}) => {
  const { t } = useTranslation('space')
  // 审批档读写规则单源在共享 hook（agentCache 强制刷新 / grant 解析 / 会话档
  // 写入 / grant 持久化），本区块只保留三档选择 UI 与升档二次确认编排。
  const {
    saving,
    currentGrant,
    approvalContext,
    targetSessionId,
    currentConversationApproval,
    applyConversationApproval,
    persistGrant,
  } = useApprovalGrantControl(spaceId, sessionId)
  // 新任务草稿尚无 session 时仍应可调档： 后本控件以工作空间 grant 为主，
  // 无 session 时升/降档走 persistGrant；生效档无显式会话覆盖时跟随 grant。
  // 不可再 `|| !targetSessionId`，否则首条消息前 composer 权限入口整组灰掉。
  const approvalSelectionDisabled = saving

  // ：升档（auto / full_access）后，若当前会话有正卡着的审批卡，就地整批放行——
  // 等价卡片「自动通过 / 全部允许」按钮的 handleApproveOnce，让阻塞中的 Agent 立即继续。
  // 根因：buildJudgePolicy 每轮 runTools 只快照一次，改 requestedApprovalMode 只能让
  // 「下一轮迭代」生效；当前批次那张卡不会被重判，故这里显式放行。降档不放行。
  // 卡片自身的升档按钮走 ApprovalTierUpgradeButton（另有 onUpgraded 放行），不经本组件，不会双提交。
  const applyConversationApprovalAndReleasePending = useCallback((next: ApprovalModeName) => {
    applyConversationApproval(next)
    if (next !== 'always_ask' && targetSessionId) {
      const chat = useChatStore.getState()
      if (chat.pendingApprovalBySessionId?.[targetSessionId]) {
        void chat.submitApprovalDecisionForSession?.(targetSessionId, 'approve')
      }
    }
  }, [applyConversationApproval, targetSessionId])

  // 升档插入 ConfirmDialog 二次确认（防误触）；降档立刻生效、不需确认。
  const [pendingGrant, setPendingGrantState] = useState<ApprovalModeName | null>(null)
  const setPendingGrant = useCallback((next: ApprovalModeName | null) => {
    setPendingGrantState(next)
    onConfirmOpenChange?.(next != null)
  }, [onConfirmOpenChange])

  // 当前对话选择只写 session；超过 Agent 授权上限时先二次确认并抬高 grant。
  const handleGrantSelect = useCallback((next: ApprovalModeName) => {
    if (next === currentConversationApproval) return
    if (approvalContext.isGroupSpace && next !== 'always_ask') {
      toast({
        description: t('security.approvalGrantGroupLocked', {
          defaultValue: 'PMO 会话固定为请求权限',
        }),
      })
      return
    }
    if (next !== 'always_ask' && !approvalContext.allowYolo) {
      toast({
        description: t('security.approvalGrantOrgLocked', {
          defaultValue: '组织未开放宽松审批，请联系组织所有者在组织设置中开启',
        }),
      })
      return
    }
    if (approvalModeRank(next) > approvalModeRank(currentGrant)) {
      // 升档（超出 Agent 已授权上限）→ 二次确认后抬 Agent grant（space 级）。
      if (!canManage) {
        toast({
          description: t('security.approvalGrantManageRequired', {
            defaultValue: '此档位需要 Agent 管理权限授权后才能使用',
          }),
        })
        return
      }
      setPendingGrant(next)
    } else if (approvalModeRank(next) < approvalModeRank(currentGrant)) {
      // ：降档也改 **Agent grant（space 级）**，不再只写当前对话——保持与
      // 权限 drawer 一致：这个控件调的是 space 级授权。管理权限校验同升档口径。
      if (!canManage) {
        toast({
          description: t('security.approvalGrantManageRequired', {
            defaultValue: '此档位需要 Agent 管理权限授权后才能使用',
          }),
        })
        return
      }
      void persistGrant(next).then((ok) => {
        if (ok) applyConversationApprovalAndReleasePending(next)
      })
    } else {
      // next === currentGrant：grant 已到位，仅同步当前对话 + 放行 pending 卡。
      applyConversationApprovalAndReleasePending(next)
    }
  }, [approvalContext.allowYolo, approvalContext.isGroupSpace, applyConversationApprovalAndReleasePending, canManage, currentConversationApproval, currentGrant, persistGrant, setPendingGrant, t])

  return (
    <>
      <div className={frameless ? 'space-y-0.5' : 'rounded-lg border border-border/20 px-4 py-3 space-y-2'}>
        {/* composer 浮层：只留三档列表；设置抽屉保留标题说明 */}
        {!frameless && (
          <div className="min-w-0">
            <span className="text-body font-medium text-foreground">
              {t('security.approvalGrantLabel', { defaultValue: '审批权限授权' })}
            </span>
            <p className={cn(SETTINGS_HINT, 'mt-0.5')}>
              {t('security.approvalGrantHint', {
                defaultValue: '选择当前对话的审批策略。选择超过已授权上限的档位时，会先为此 Agent 授权；PMO 会话仍固定为请求权限。',
              })}
            </p>
          </div>
        )}
        <div className="space-y-0.5" role="radiogroup" aria-label={t('security.approvalGrantLabel', { defaultValue: '审批权限授权' })}>
          {APPROVAL_MODE_NAMES.map((tier) => {
            const Icon = GRANT_TIER_ICON[tier]
            const isSelected = tier === currentConversationApproval
            const orgLocked = tier !== 'always_ask' && !approvalContext.allowYolo
            const grantLocked = approvalModeRank(tier) > approvalModeRank(currentGrant) && !canManage
            const optionDisabled = approvalSelectionDisabled || orgLocked || grantLocked
            return (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => handleGrantSelect(tier)}
                disabled={optionDisabled}
                data-approval-grant={tier}
                data-org-locked={orgLocked ? 'true' : undefined}
                className={cn(
                  'flex items-start gap-3 w-full px-3 py-2.5 rounded-lg text-left transition-colors',
                  optionDisabled ? 'cursor-not-allowed' : 'hover:bg-muted/40',
                  isSelected && 'bg-muted/60',
                  optionDisabled && 'opacity-60',
                )}
              >
                <Icon className={cn(
                  'h-4 w-4 mt-0.5 shrink-0',
                  tier === 'auto' && 'text-warning',
                  tier === 'full_access' && 'text-destructive',
                  tier === 'always_ask' && 'text-muted-foreground',
                )} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-body font-medium', isSelected ? 'text-foreground' : 'text-foreground/80')}>
                      {t(`security.approvalGrant.${tier}.name`)}
                    </span>
                    {orgLocked && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-warning/10 px-1.5 py-px text-caption font-medium text-warning">
                        {t('security.approvalGrantOrgBadge', { defaultValue: '组织未开放' })}
                      </span>
                    )}
                    {grantLocked && !orgLocked && (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-foreground/[0.04] px-1.5 py-px text-caption font-medium text-muted-foreground">
                        {t('security.approvalGrantManageBadge', { defaultValue: '需管理员授权' })}
                      </span>
                    )}
                  </div>
                  <p className={cn(SETTINGS_HINT, 'mt-0.5')}>
                    {t(`security.approvalGrant.${tier}.description`)}
                  </p>
                </div>
                {isSelected && (
                  <Check className="h-3.5 w-3.5 mt-0.5 text-primary shrink-0" />
                )}
              </button>
            )
          })}
        </div>
      </div>

      {/* 升档二次确认对话框（，替代旧 yolo gate 确认） */}
      <ConfirmDialog
        open={pendingGrant != null}
        onOpenChange={(open) => { if (!open) setPendingGrant(null) }}
        container={confirmDialogContainer}
        title={t('security.approvalGrantConfirmTitle', {
          tier: pendingGrant ? t(`security.approvalGrant.${pendingGrant}.name`) : '',
          defaultValue: '授权「{{tier}}」？',
        })}
        description={pendingGrant === 'full_access'
          ? t('security.approvalGrantConfirmBodyFullAccess', {
              defaultValue: '授权后，当前对话将按「全部允许」执行：无需授权直接执行，仅灾难级命令被拦截。此 Agent 会记住该授权上限，之后可在此处收回。',
            })
          : t('security.approvalGrantConfirmBodyAuto', {
              defaultValue: '授权后，当前对话将按「自动通过」执行：常规操作自动批准，仅高风险操作仍会询问。此 Agent 会记住该授权上限，之后可在此处收回。',
            })}
        variant="destructive"
        onConfirm={() => {
          const next = pendingGrant
          setPendingGrant(null)
          if (!next) return
          void persistGrant(next).then((ok) => {
            if (ok) applyConversationApprovalAndReleasePending(next)
          })
        }}
      />
    </>
  )
}
