/**
 * 前端 → Host turn 状态推送载荷。
 *
 * 以前端 store 为准：有 agent_config 可推；组织 YOLO 天花板由
 * organization-store 在权威已知后经 `setHostTurnOrganizationAllowMemberYolo`
 * 写入本模块。未知时为 null，禁止把缺省 false 当「组织未开放」推给 Host
 * 。Host securityReady 也要求 YOLO 为已知 boolean 才可 compose。
 */

import type { Agent, Space } from '../types/space.js'
import { getRuntime } from '../runtime.js'

/** 当前组织天花板；未知 null；仅权威 sync 后为 boolean。 */
let organizationAllowMemberYolo: boolean | null = null

/** 最近一次完整推送的 Agent，供组织天花板局部 upsert 定位目标。 */
let lastPushedAgentId: string | null = null

/** @returns 已知天花板；未知为 null（勿当 false）。 */
export function resolveOrganizationAllowMemberYolo(): boolean | null {
  return organizationAllowMemberYolo
}

/** 组织 settings 权威已知后写入天花板，并在已有 Agent 推送时局部同步 Host。 */
export function setHostTurnOrganizationAllowMemberYolo(allowMemberYolo: boolean): void {
  organizationAllowMemberYolo = allowMemberYolo === true
  if (!lastPushedAgentId) return
  pushHostOrganizationAllowMemberYolo(lastPushedAgentId, organizationAllowMemberYolo)
}

/** 切组织 / 登出：清空天花板，后续 agent push 不再夹带 YOLO 字段。 */
export function clearHostTurnOrganizationAllowMemberYolo(): void {
  organizationAllowMemberYolo = null
}

/** 推 Host turn：带齐安全合成所需字段，避免发送路径再打 DETAIL。 */
export function buildHostAgentTurnPush(agent: Agent) {
  return {
    id: agent.id,
    ...(organizationAllowMemberYolo !== null && agent.agent_config !== undefined
      ? {
          detail: {
            ...agent,
            organization_allow_member_yolo: organizationAllowMemberYolo,
          },
        }
      : {}),
    display_name: agent.display_name ?? null,
    name: agent.name,
    ...(agent.custom_rules !== undefined ? { custom_rules: agent.custom_rules } : {}),
    ...(agent.personal_rules !== undefined ? { personal_rules: agent.personal_rules } : {}),
    ...(agent.agent_config !== undefined ? { agent_config: agent.agent_config } : {}),
    // 仅权威已知时写 boolean；未知省略，避免 Host 把缺省 false 当未开放。
    ...(organizationAllowMemberYolo !== null
      ? { organization_allow_member_yolo: organizationAllowMemberYolo }
      : {}),
  }
}

export function buildHostWorkspaceTurnPush(
  space: Pick<Space, 'id' | 'custom_rules' | 'execution_limits' | 'approval_grant'>,
) {
  return {
    id: space.id,
    ...(space.custom_rules !== undefined ? { custom_rules: space.custom_rules } : {}),
    ...(space.execution_limits !== undefined ? { execution_limits: space.execution_limits } : {}),
    ...(space.approval_grant !== undefined ? { approval_grant: space.approval_grant } : {}),
  }
}

export function pushHostAgentTurnState(agent: Agent | null | undefined): void {
  if (!agent?.id) return
  lastPushedAgentId = agent.id
  getRuntime().bridge.pushHostTurnState?.({
    agent: buildHostAgentTurnPush(agent),
  })
}

/** 组织天花板变更时，只补推当前 Agent 的 org 字段（局部 upsert 不丢 agent_config）。 */
export function pushHostOrganizationAllowMemberYolo(
  agentId: string | null | undefined,
  allowMemberYolo: boolean,
): void {
  const id = typeof agentId === 'string' ? agentId.trim() : ''
  if (!id) return
  getRuntime().bridge.pushHostTurnState?.({
    agent: {
      id,
      organization_allow_member_yolo: allowMemberYolo === true,
    },
  })
}

/** 身份切换 / 登出：清模块级 YOLO 推送指针。 */
export function resetHostTurnPush(): void {
  organizationAllowMemberYolo = null
  lastPushedAgentId = null
}

/** @deprecated 使用 {@link resetHostTurnPush} */
export function resetHostTurnPushForTest(): void {
  resetHostTurnPush()
}
