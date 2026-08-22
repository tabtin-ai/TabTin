/**
 * 宿主能力目录身份初始化。
 *
 *  去 TTL 后，CLI media gate / Skill enablement / MCP listing 等改为常驻。
 * 登录、登出、auth 变更、切组织必须对称失效，否则上一身份的能力会串到下一身份。
 *
 * 本模块只编排「清什么」；ElectronAgentHost 注入 Port 并决定是否再暖。
 */

export type CapabilityIdentityInitReason =
  | 'login'
  | 'logout'
  | 'auth-changed'
  | 'organization-switch'
  | 'manual'

export type HostCapabilityIdentityInitPorts = {
  /** 清空 CLI 物化 + MCP listing 常驻缓存 */
  resetCatalog: () => void
  /** 全清 Agent Skill enablement */
  invalidateAllSkillEnablement: () => void
  /** 清 media 门控判定 */
  invalidateCliListingGate: () => void
  /** 清 HostTurn（rules / agent_config / YOLO 天花板） */
  clearHostTurn: () => void
  /** 清预热 pending / in-flight（保留 handler） */
  clearPrewarmPending: () => void
  /** 清用户画像缓存 */
  invalidateUserPortrait: () => void
  logInfo?: (message: string, meta?: Record<string, unknown>) => void
}

export type CapabilityIdentityInitOptions = {
  /** 切组织再暖时优先用目标 org，避免 CLI context 尚未切换时灌旧门控 */
  organizationId?: string | null
}

/**
 * 统一失效入口。调用方在登录/登出/切组织等时机调用；
 * 是否随后 `warmHostCapabilityCatalogs` 由 Host 决定。
 */
export function initHostCapabilityIdentity(
  reason: CapabilityIdentityInitReason,
  ports: HostCapabilityIdentityInitPorts,
): void {
  ports.resetCatalog()
  ports.invalidateAllSkillEnablement()
  ports.invalidateCliListingGate()
  ports.clearHostTurn()
  ports.clearPrewarmPending()
  ports.invalidateUserPortrait()
  ports.logInfo?.('[CapabilityIdentity] init', { reason })
}

/** 登出 / 未登录：清完后不要再暖。 */
export function shouldRewarmAfterCapabilityIdentityInit(
  reason: CapabilityIdentityInitReason,
): boolean {
  return reason === 'login'
    || reason === 'organization-switch'
    || reason === 'auth-changed'
    || reason === 'manual'
}
