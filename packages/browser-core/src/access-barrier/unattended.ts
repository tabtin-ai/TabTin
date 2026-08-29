/**
 * scheduled/batch 无人值守、或宿主 HITL 不可用时的诚实失败决议（设计 §7.2 / §7.3）。
 *
 * 硬约束：**不能**假装成功或静默换源——`host_unavailable` 是系统结局，非用户三选一。
 */
import type { AccessBarrier, AccessBarrierResolution } from './types.js'

/** 无人值守 / HITL 不可用时的决议：`{ action: 'host_unavailable' }`。 */
export function buildUnattendedResolution(_barrier: AccessBarrier): AccessBarrierResolution {
  return { action: 'host_unavailable' }
}
