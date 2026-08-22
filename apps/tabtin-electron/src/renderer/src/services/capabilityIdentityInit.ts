/**
 * ：能力目录身份初始化（渲染侧）。
 *
 * 主进程常驻目录由 IPC `agent-engine:init-capability-identity` 失效；
 * 本模块同时清渲染侧与身份绑定的瞬态状态（ActiveRunBinding / superseded /
 * HostTurn YOLO 指针）。切组织不清聊天消息（Wave 3 /  口径不变）。
 */

import { onOrganizationSelected, resetHostTurnPush } from '@tabtin/app-shell'
import { clearAllActiveRunBindings } from '@/stores/chat/execution/activeRunBinding'
import { clearAllSupersededRuns } from '@/stores/chat/stream/handlers/supersededRuns'
import { registerResetAction } from '@/stores/sessionResetRegistry'
import { createLogger } from '@/utils/logger'

const log = createLogger('CapabilityIdentity')

export type CapabilityIdentityInitReason =
  | 'login'
  | 'logout'
  | 'auth-changed'
  | 'organization-switch'
  | 'manual'

function clearRendererCapabilityIdentityState(): void {
  clearAllActiveRunBindings()
  clearAllSupersededRuns()
  resetHostTurnPush()
}

/**
 * 统一入口：先清渲染侧瞬态，再通知主进程失效常驻能力目录。
 */
export async function initCapabilityIdentity(
  reason: CapabilityIdentityInitReason,
  options?: { organizationId?: string | null },
): Promise<void> {
  clearRendererCapabilityIdentityState()
  const ipc = window.tabtin?.agentEngine?.initCapabilityIdentity
  if (!ipc) return
  try {
    await ipc({
      reason,
      organizationId: options?.organizationId ?? undefined,
    })
  } catch (error) {
    log.warn('init IPC failed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

let wired = false
/** 上次已做过 identity init 的组织；同 org 再 emit（TTL 命中）跳过。 */
let lastOrganizationId: string | null = null

/** 挂接登出 reset + 切组织。幂等。 */
export function wireCapabilityIdentityLifecycle(): void {
  if (wired) return
  wired = true

  registerResetAction('capability-identity', 'reset', () => {
    lastOrganizationId = null
    clearRendererCapabilityIdentityState()
    // 登出主路径还会走 resetAccountSync → main init(logout)；
    // 这里再发一次 logout 作对称兜底（幂等）。
    void initCapabilityIdentity('logout')
  })

  onOrganizationSelected((organizationId) => {
    if (!organizationId || organizationId === lastOrganizationId) {
      return
    }
    lastOrganizationId = organizationId
    void initCapabilityIdentity('organization-switch', { organizationId })
  })
}

/** Test-only */
export function __resetCapabilityIdentityLifecycleForTest(): void {
  wired = false
  lastOrganizationId = null
}

// 模块加载即挂接：登出 reset + 切组织。
wireCapabilityIdentityLifecycle()
