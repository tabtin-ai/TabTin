import { useEffect } from 'react'

/**
 * ApprovalMemoStoreSyncHost — 把 approval_memo 变更同步进 space store。
 *
 * 「已记住的授权」读的是 store 里 agent.agent_config.approval_memo（agentCache 快照）。
 * 审批 always commit 到 Django 后 agentCache 不会自动失效，且 Django 的
 * approval_memo_updated 广播通常不回发给发起端——所以主进程在本机 commit 成功 /
 * 收到远端广播时，通过 IPC 主动推 { agentId }，这里据此强制重拉该 agent，刷新 store，
 * 让任何订阅 store 的界面（尤其设置 drawer 的「已记住的授权」）实时更新。
 *
 * 只刷新已在 agentCache / 当前选中的 agent，避免把无关 agent 拉进缓存。
 */
export function ApprovalMemoStoreSyncHost(): null {
  useEffect(() => {
    const api = window.tabtin?.agentEngine
    if (!api?.onApprovalMemoChanged) return
    const unsubscribe = api.onApprovalMemoChanged(({ workspaceId }) => {
      if (!workspaceId) return
      window.dispatchEvent(new CustomEvent('tabtin:approval-memo-changed', {
        detail: { workspaceId },
      }))
    })
    return unsubscribe
  }, [])

  return null
}
