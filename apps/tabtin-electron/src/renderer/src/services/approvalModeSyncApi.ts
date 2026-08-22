/**
 * Renderer → main 审批档 live 同步。
 *
 *  起 Workspace approval_grant 是唯一权限数据源。本服务在授权档变更后通知
 * 主进程重拉权威 Workspace grant，使运行中会话和其子代理立即看到新档。
 * `approvalMode` payload 仅为 IPC 兼容保留，主进程不信任也不用于判决。
 *
 * 失败 fail-soft——UI 切档主路径不应被 IPC 失败阻断；无运行中 session 时主进程
 * no-op（下一条消息发送自然快照新档）。
 */

export interface NotifyApprovalModeChangedPayload {
  sessionId: string
  approvalMode: string
}

export interface NotifyApprovalModeChangedResult {
  success: boolean
  /** 是否真的命中运行中 session 并 mutate（无运行中 session 时为 false）。 */
  applied?: boolean
}

export async function notifyApprovalModeChanged(
  payload: NotifyApprovalModeChangedPayload,
): Promise<NotifyApprovalModeChangedResult> {
  const ipc = window.tabtin?.agentEngine
  if (!ipc?.notifyApprovalModeChanged) {
    return { success: false }
  }
  try {
    const ack = await ipc.notifyApprovalModeChanged(payload)
    return {
      success: ack?.success === true,
      applied: ack?.applied,
    }
  } catch {
    return { success: false }
  }
}
