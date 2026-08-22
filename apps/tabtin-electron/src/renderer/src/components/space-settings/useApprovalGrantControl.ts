/**
 * useApprovalGrantControl — 审批档（ 三档策略）读写控制的共享 hook
 *
 * 从 ApprovalGrantSection 抽出，两处复用、规则单源：
 * - 「审批权限授权」三档选择区块（ApprovalGrantSection，设置抽屉 / composer 浮层）
 * - 审批卡片就地升档按钮（ApprovalTierUpgradeButton，）
 *
 * 职责边界：只提供「当前档位 / 上限 / 锁定上下文」读数与「写会话档 / 抬 Workspace
 * grant」两个写入口；升档二次确认等交互（何时弹 ConfirmDialog）由调用方自己编排。
 */

import { useCallback, useEffect, useMemo } from 'react'
import { toast } from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useChatStore } from '@stores/chat/useChatStore'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceExecutionAgent } from './hooks/useSpaceExecutionAgent'
import { useTranslation } from 'react-i18next'
import { isApprovalModeName, type ApprovalModeName } from '@/stores/chat/shared/types'
import { resolveProjectExecutionWorkspace } from '@utils/projectExecutionTarget'
import {
  buildAgentModeResolutionContext,
  resolveAllowYoloFromOrganization,
  type AgentModeResolutionContext,
} from '@/stores/chat/group/groupRuntimeContext'
import {
  setSessionApprovalMode,
  useEffectiveSessionApprovalMode,
} from '@/stores/chat/session/sessionApprovalMode'

export interface ApprovalGrantControl {
  /** 读写请求进行中（禁用交互用）。 */
  saving: boolean
  /** 工作空间已授权的最高审批档。 */
  currentGrant: ApprovalModeName
  /** 组织开关 / PMO 群会话等锁定上下文。 */
  approvalContext: AgentModeResolutionContext
  /**
   * 审批档实际作用的会话（缺省回退到 Space 当前会话）。
   * 新任务草稿可为 null：此时升/降档只走 persistGrant，生效档跟随工作空间 grant。
   */
  targetSessionId: string | null
  /** 目标会话当前生效审批档（无会话时跟随工作空间 grant）。 */
  currentConversationApproval: ApprovalModeName
  /** 写入目标会话审批档（session 级，不动工作空间 grant；无会话时 no-op）。 */
  applyConversationApproval: (value: ApprovalModeName) => void
  /** 抬高工作空间 approval_grant 上限并持久化；失败已 toast，返回是否成功。 */
  persistGrant: (value: ApprovalModeName) => Promise<boolean>
}

export interface UseApprovalGrantControlOptions {
  /**
   * 挂载时是否强制拉一次最新 agent_config（：审批 commit 后 agentCache 不
   * 自动失效，设置面板打开需强刷避免展示旧 grant / memo 快照）。
   *
   * 默认 `true` 供设置面板 / 浮层用。**审批卡片就地升档按钮应传 `false`**——
   * 该按钮随每张审批卡挂载（且 hooks 规则下即使按钮 return null 也会跑），
   * 每卡都 force fetch 是无谓网络开销；它只需读 `useSpaceExecutionAgent`
   * 已填充的缓存来判断当前档位，缓存缺失时后者自身会补拉。
   */
  refreshOnMount?: boolean
}

export function useApprovalGrantControl(
  spaceId: string,
  sessionId: string | null,
  options: UseApprovalGrantControlOptions = {},
): ApprovalGrantControl {
  const { refreshOnMount = true } = options
  const { t } = useTranslation('space')
  const {
    space,
    agentId,
    isLoading: agentLoading,
  } = useSpaceExecutionAgent(spaceId)
  const {
    spaces,
    updateWorkspaceApprovalGrant,
    loadAgent,
    isLoading,
  } = useSpaceStore(
    useShallow((state) => ({
      spaces: state.spaces,
      updateWorkspaceApprovalGrant: state.updateWorkspaceApprovalGrant,
      loadAgent: state.loadAgent,
      isLoading: state.isLoading,
    })),
  )

  // agent_config（含 approval_grant / approval_memo）在审批 commit 到 Django 后
  // agentCache 不会自动失效——挂载时强制拉一次最新，避免展示旧快照。
  useEffect(() => {
    if (!refreshOnMount || !agentId) return
    void loadAgent(agentId, { force: true })
  }, [refreshOnMount, agentId, loadAgent])

  const saving = isLoading || agentLoading
  const executionWorkspace = useMemo(
    () => resolveProjectExecutionWorkspace(space, spaces),
    [space, spaces],
  )
  const currentGrant = isApprovalModeName(executionWorkspace?.approval_grant)
    ? executionWorkspace.approval_grant
    : 'always_ask'
  const currentSessionIdForSpace = useChatStore(s => s.currentSessionIdBySpaceId[spaceId] ?? null)
  const targetSessionId = sessionId ?? currentSessionIdForSpace
  const selectedOrganization = useOrganizationStore(s => s.selectedOrganization)
  const groupRuntime = useChatRuntimeStore(s => (
    targetSessionId ? s.groupRuntimeBySessionId[targetSessionId] : null
  ))
  // ：锁定上下文里的 approvalGrant 与 currentGrant 同源（工作空间），
  // 不再从 Agent legacy allow_yolo_mode 推导，避免 full_access 被夹成 auto。
  const approvalContext = useMemo(
    () => buildAgentModeResolutionContext(
      resolveAllowYoloFromOrganization(selectedOrganization),
      groupRuntime,
      executionWorkspace,
    ),
    [executionWorkspace, groupRuntime, selectedOrganization],
  )
  const currentConversationApproval = useEffectiveSessionApprovalMode(targetSessionId)

  // 实际写入 approval_grant 的纯函数（ 三档审批策略）。
  // 后端 agent_service 校验枚举后同步 legacy allow_yolo_mode（grant != 'always_ask'）。
  const applyConversationApproval = useCallback((value: ApprovalModeName) => {
    if (!targetSessionId) return
    setSessionApprovalMode(targetSessionId, value)
  }, [targetSessionId])

  const persistGrant = useCallback(async (value: ApprovalModeName): Promise<boolean> => {
    if (!executionWorkspace) {
      toast({
        description: t('profileSheet.noExecutionContext', {
          defaultValue: '暂无法保存此工作空间的执行设置，请刷新后重试',
        }),
        variant: 'destructive',
      })
      return false
    }
    try {
      const ok = await updateWorkspaceApprovalGrant(executionWorkspace.id, value)
      if (!ok) {
        toast({ description: t('errors.updateFailed', { defaultValue: '操作失败' }), variant: 'destructive' })
        return false
      }
      return true
    } catch {
      toast({ description: t('errors.updateFailed', { defaultValue: '操作失败' }), variant: 'destructive' })
      return false
    }
  }, [executionWorkspace, t, updateWorkspaceApprovalGrant])

  return {
    saving,
    currentGrant,
    approvalContext,
    targetSessionId,
    currentConversationApproval,
    applyConversationApproval,
    persistGrant,
  }
}
