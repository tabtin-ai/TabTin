import { useMemo } from 'react'
import { useChatStore } from '../useChatStore'
import { useChatRuntimeStore } from '../../useChatRuntimeStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { resolveProjectExecutionWorkspace } from '@utils/projectExecutionTarget'
import {
  resolveApprovalModeName,
  resolveEffectiveApprovalMode,
  type ApprovalModeName,
} from '../shared/types'
import { getAgentModeResolutionContextForSession } from '../group/groupRuntimeContext'

/**
 * ：Workspace `approval_grant` 是审批档唯一真源。
 * 下列 record 读取仅供旧持久化状态兼容；不再参与权限判决。
 */
export function getSessionApprovalModeRecord(): Record<string, ApprovalModeName> {
  return useChatStore.getState().approvalModeBySessionId
}

export function getSessionApprovalMode(
  sessionId: string | null | undefined,
): ApprovalModeName | undefined {
  if (!sessionId) return undefined
  return useChatStore.getState().approvalModeBySessionId[sessionId]
}

export function setSessionApprovalMode(sessionId: string, mode: ApprovalModeName): void {
  const modeToApply = resolveApprovalModeName(mode, 'always_ask')
  // 只通知主进程重拉 Workspace 权威 grant，使运行中 turn 即时看到新档；不再
  // 写会话级覆盖。
  void import('@/services/approvalModeSyncApi')
    .then(({ notifyApprovalModeChanged }) =>
      notifyApprovalModeChanged({ sessionId, approvalMode: modeToApply }),
    )
    .catch(() => {
      /* fail-soft：UI 切档主路径不应被 IPC 失败阻断 */
    })
}

export function resolveEffectiveSessionApprovalMode(
  sessionId: string | null | undefined,
  fallback: ApprovalModeName = 'always_ask',
): ApprovalModeName {
  const record = getSessionApprovalModeRecord()
  const context = getAgentModeResolutionContextForSession(sessionId)
  return resolveEffectiveApprovalMode(
    sessionId,
    record,
    fallback,
    context,
  )
}

/** 订阅当前会话生效审批档（与 Space 安全面板 / 输入框共用）。 */
export function useEffectiveSessionApprovalMode(
  sessionId: string | null | undefined,
  fallback: ApprovalModeName = 'always_ask',
): ApprovalModeName {
  const groupRuntime = useChatRuntimeStore(s => (
    sessionId ? s.groupRuntimeBySessionId[sessionId] : null
  ))
  const allowMemberYolo = useOrganizationStore(
    s => s.selectedOrganization?.settings?.allow_member_yolo,
  )
  // ：生效档上限跟 Workspace.approval_grant，不再订阅 selectedAgent。
  const workspaceApprovalGrant = useSpaceStore((s) => {
    const executionWorkspace = resolveProjectExecutionWorkspace(s.selectedSpace, s.spaces)
    return executionWorkspace?.approval_grant ?? null
  })

  return useMemo(
    () => resolveEffectiveSessionApprovalMode(sessionId, fallback),
    [
      sessionId,
      groupRuntime,
      allowMemberYolo,
      workspaceApprovalGrant,
      fallback,
    ],
  )
}
