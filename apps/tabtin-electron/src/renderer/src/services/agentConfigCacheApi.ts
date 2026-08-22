/**
 * Renderer → main：Host turn 状态推送 / 失效。
 *
 * Settings / 选 Agent / 改规则成功后 upsert；需要强制重拉时 invalidate。
 */

export type HostTurnStateAgentPayload = {
  id: string
  detail?: Record<string, unknown>
  display_name?: string | null
  name?: string | null
  custom_rules?: string | null
  personal_rules?: string | null
  agent_config?: unknown
  organization_allow_member_yolo?: boolean | null
}

export type HostTurnStateWorkspacePayload = {
  id: string
  custom_rules?: string | null
  execution_limits?: {
    max_iterations_per_run?: number | null
    max_credits_per_run?: number | string | null
    enabled?: boolean | null
  } | null
  approval_grant?: 'always_ask' | 'auto' | 'full_access' | null
}

export async function invalidateAgentConfigCache(agentId?: string): Promise<boolean> {
  const ipc = window.tabtin?.agentEngine
  if (!ipc?.invalidateAgentConfigCache) return false
  try {
    const ack = await ipc.invalidateAgentConfigCache(agentId ? { agentId } : undefined)
    return ack?.success === true
  } catch {
    return false
  }
}

export async function upsertHostTurnState(payload: {
  agent?: HostTurnStateAgentPayload
  workspace?: HostTurnStateWorkspacePayload
}): Promise<boolean> {
  const ipc = window.tabtin?.agentEngine
  if (!ipc?.upsertHostTurnState) return false
  try {
    const ack = await ipc.upsertHostTurnState(payload)
    return ack?.success === true
  } catch {
    return false
  }
}

/** fire-and-forget：store 写成功后推 Host，失败不影响主路径。 */
export function pushHostTurnState(payload: {
  agent?: HostTurnStateAgentPayload
  workspace?: HostTurnStateWorkspacePayload
}): void {
  void upsertHostTurnState(payload)
}
