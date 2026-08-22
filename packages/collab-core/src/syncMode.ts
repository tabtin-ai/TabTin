import { shouldFallbackToLegacy } from "./errors.js";
import { CloseCode, CollabStatus } from "./types.js";

export type CollabSyncMode = "collab" | "legacy";

export type CollabSyncModeReason =
  | "flag_disabled"
  | "collab_unavailable"
  | "sharding_unavailable"
  | "force_closed"
  | "runtime_fallback"
  | "module_not_migrated"
  /**  / ：字段可见性受限，业务终态走 REST 投影，不得进全量 Y.Doc */
  | "field_visibility_restricted"
  /** 明确无资源权限；终态，不得显示网络重连语义。 */
  | "permission_denied"
  /** 父文档协作真源暂不可解析；停止自动建连，刷新后可重新验证。 */
  | "access_verification_unavailable"
  /** WS 握手持续挂起（连续 watchdog 触发），网络栈可能坏死，降级 REST 兼容同步 */
  | "stuck_connecting";

/**
 * 连续 watchdog 触发达到此次数即视同 disconnectTimedOut 降级。
 * watchdog 周期 60s：第 2 次触发≈挂起 120s——第 1 次可能只是偶发慢，
 * 重建后仍连不上才认定网络栈坏死。
 */
export const STUCK_CONNECTING_FALLBACK_THRESHOLD = 2;

export interface CollabSyncModeState {
  mode: CollabSyncMode;
  reason?: CollabSyncModeReason;
}

export interface ResolveCollabSyncModeInput {
  collabDisabled?: boolean;
  providerConfigured?: boolean;
  status: CollabStatus;
  forceCloseCode?: number;
  disconnectTimedOut?: boolean;
  moduleMigrated?: boolean;
  shardingRequired?: boolean;
  shardingAvailable?: boolean;
  /** 连续 CONNECTING watchdog 触发次数（CollabState.watchdogTriggerCount），连接成功后清零 */
  watchdogTriggerCount?: number;
  /**
   * 业务终态强制 legacy（如字段可见性 rest_projection）。
   * 优先级高于 providerConfigured / 运行时断连降级。
   */
  forcedLegacyReason?: CollabSyncModeReason;
}

export interface LegacyDomainDeltaDecisionInput {
  syncMode: CollabSyncMode;
  eventKind: "domain" | "control" | "metadata";
}

/**
 * Resolve the resource-level collaboration mode.
 *
 * This is intentionally resource/module-level, not action-level. In collab mode
 * domain state is driven by Y.Doc commands only; legacy deltas are consumed only
 * after the whole resource has entered legacy mode.
 */
export function resolveCollabSyncMode(input: ResolveCollabSyncModeInput): CollabSyncModeState {
  if (input.forcedLegacyReason) {
    return { mode: "legacy", reason: input.forcedLegacyReason };
  }
  if (input.collabDisabled) {
    return { mode: "legacy", reason: "flag_disabled" };
  }
  if (input.moduleMigrated === false) {
    return { mode: "legacy", reason: "module_not_migrated" };
  }
  if (!input.providerConfigured) {
    return { mode: "legacy", reason: "collab_unavailable" };
  }
  if (input.shardingRequired && !input.shardingAvailable) {
    return { mode: "legacy", reason: "sharding_unavailable" };
  }
  if (
    input.status === CollabStatus.FORCE_CLOSED
    && input.forceCloseCode === CloseCode.PERMISSION_DENIED
  ) {
    return { mode: "legacy", reason: "permission_denied" };
  }
  if (shouldFallbackToLegacy(input.status, input.forceCloseCode, input.disconnectTimedOut)) {
    const reason = input.status === CollabStatus.FORCE_CLOSED ? "force_closed" : "runtime_fallback";
    return { mode: "legacy", reason };
  }
  // 握手挂起降级（ 兜底）：网络栈坏死时 status 恒为 CONNECTING，
  // disconnectTimedOut 永不触发，只能靠 watchdog 连续触发计数判定。
  // 连接恢复（onConnect）时计数清零，自动升回 collab。
  // FORCE_CLOSED 短路：归档/权限变更等终态应走 READONLY / PROMPT_RELOAD
  // 语义，而此时 onConnect 永不会来、计数无清零机会，不得被残留计数误判。
  if (
    input.status !== CollabStatus.FORCE_CLOSED
    && (input.watchdogTriggerCount ?? 0) >= STUCK_CONNECTING_FALLBACK_THRESHOLD
  ) {
    return { mode: "legacy", reason: "stuck_connecting" };
  }
  return { mode: "collab" };
}

/**
 * Guardrail for the Y.Doc-first migration: legacy business/domain deltas are
 * allowed to affect UI state only when the whole resource is in legacy mode.
 */
export function shouldConsumeLegacyDomainDelta(input: LegacyDomainDeltaDecisionInput): boolean {
  return input.eventKind === "domain" && input.syncMode === "legacy";
}
