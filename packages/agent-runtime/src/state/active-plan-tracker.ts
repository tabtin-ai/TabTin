/**
 * Active Plan Tracker — 当前 session 正在草拟的 Plan 指针（SSoT）
 *
 * PlanStore adapter 化后，active plan 不再是单一 documentId 字符串，而是统一
 * {@link PlanRef}（file 载体 = 本地 plan 文件路径；document 载体 = TabDoc id）。
 *
 * - 由 `plan_create` 工具在 store 写入成功后调用 {@link markActivePlan}；
 * - guard 通过 {@link getActivePlan}（仅返回 document 载体的 id，file 载体返回 null）
 *   做 `tabdoc_update_document` 的 target 校验——file 载体不参与 target 豁免；
 * - reminder 通过 {@link getActivePlanFilePath}（仅返回 file 载体路径）注入 per-turn 提示；
 * - 工具 / 继续消息通过 {@link getActivePlanRef} 拿完整 ref。
 *
 * 清理：
 *   - **主路径**：host 在 session dispose / mode 软切换（plan→非 plan）/ query abort /
 *     **rollback pipeline** 时调用 {@link clearAllForSession}；
 *   - **兜底**：lazy TTL（默认 24h），在 get / mark 高低频路径顺手清过期 entry。
 */

import { planRefKey } from '../engine/contracts/plan-ref.js';
import type { PlanRef } from '../engine/contracts/wire-payloads.js';

export interface ActivePlanEntry {
  /** 统一 plan 指针（file 载体路径 / document 载体 id）。 */
  ref: PlanRef;
  /** plan_create 完成时的本地时间戳，仅做调试 / telemetry 用。 */
  createdAt: number;
}

const ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

function isExpired(entry: ActivePlanEntry, now: number): boolean {
  return now - entry.createdAt >= ENTRY_TTL_MS;
}

export type ActivePlanClearReason =
  | 'plan_exit'
  | 'session_dispose'
  | 'rollback'
  | 'manual'
  | 'reset';

export type ActivePlanChangeEvent =
  | {
      type: 'set';
      sessionId: string;
      ref: PlanRef;
      previousRef?: PlanRef;
    }
  | {
      type: 'clear';
      sessionId: string;
      previousRef?: PlanRef;
      reason: ActivePlanClearReason;
    };

/**
 * Session active plan registry.
 *
 * 默认导出的函数继续走模块级单例；class 让测试 / 宿主后续可以按生命周期创建
 * 独立实例，不再把 Map + listener 散在模块顶层。
 */
export class ActivePlanTracker {
  private readonly plans = new Map<string, ActivePlanEntry>();
  private onChange:
    | ((event: ActivePlanChangeEvent) => void)
    | undefined;

  mark(sessionId: string, ref: PlanRef): void {
    const trimmedSession = sessionId?.trim();
    if (!trimmedSession || !ref) return;

    const now = Date.now();
    this.sweepExpired(now);

    const existing = this.plans.get(trimmedSession);
    if (existing && planRefKey(existing.ref) === planRefKey(ref) && !isExpired(existing, now)) {
      return;
    }
    this.plans.set(trimmedSession, { ref, createdAt: now });
    this.onChange?.({
      type: 'set',
      sessionId: trimmedSession,
      ref,
      previousRef: existing?.ref,
    });
  }

  clear(
    sessionId: string,
    options?: { expectedRef?: PlanRef; reason?: ActivePlanClearReason },
  ): boolean {
    const trimmedSession = sessionId?.trim();
    if (!trimmedSession) return false;

    const existing = this.plans.get(trimmedSession);
    if (!existing) return false;
    if (options?.expectedRef && planRefKey(existing.ref) !== planRefKey(options.expectedRef)) {
      return false;
    }

    this.plans.delete(trimmedSession);
    this.onChange?.({
      type: 'clear',
      sessionId: trimmedSession,
      previousRef: existing.ref,
      reason: options?.reason ?? 'manual',
    });
    return true;
  }

  getRef(sessionId: string): PlanRef | null {
    const trimmedSession = sessionId?.trim();
    if (!trimmedSession) return null;
    const entry = this.plans.get(trimmedSession);
    if (!entry) return null;
    if (isExpired(entry, Date.now())) {
      this.expireEntry(trimmedSession, entry);
      return null;
    }
    return entry.ref;
  }

  getDocumentId(sessionId: string): string | null {
    const ref = this.getRef(sessionId);
    if (!ref) return null;
    return ref.kind === 'document' ? ref.document_id : null;
  }

  getFilePath(sessionId: string): string | null {
    const ref = this.getRef(sessionId);
    if (!ref) return null;
    return ref.kind === 'file' ? ref.path : null;
  }

  clearAllForSession(sessionId: string): void {
    const trimmedSession = sessionId?.trim();
    if (!trimmedSession) return;
    const existing = this.plans.get(trimmedSession);
    if (!existing) return;
    this.plans.delete(trimmedSession);
    this.onChange?.({
      type: 'clear',
      sessionId: trimmedSession,
      previousRef: existing.ref,
      reason: 'session_dispose',
    });
  }

  snapshot(): Array<{ sessionId: string; ref: PlanRef; createdAt: number }> {
    this.sweepExpired(Date.now());
    return Array.from(this.plans.entries()).map(([sessionId, entry]) => ({
      sessionId,
      ref: entry.ref,
      createdAt: entry.createdAt,
    }));
  }

  setChangeListener(
    cb: ((event: ActivePlanChangeEvent) => void) | undefined,
  ): void {
    this.onChange = cb;
  }

  resetForTests(): void {
    this.plans.clear();
    this.onChange = undefined;
  }

  private expireEntry(sessionId: string, entry: ActivePlanEntry): boolean {
    if (!this.plans.delete(sessionId)) {
      return false;
    }
    this.onChange?.({
      type: 'clear',
      sessionId,
      previousRef: entry.ref,
      reason: 'reset',
    });
    return true;
  }

  private sweepExpired(now: number): void {
    if (this.plans.size === 0) return;
    const expired: Array<[string, ActivePlanEntry]> = [];
    for (const [sid, entry] of this.plans.entries()) {
      if (isExpired(entry, now)) {
        expired.push([sid, entry]);
      }
    }
    for (const [sid, entry] of expired) {
      this.expireEntry(sid, entry);
    }
  }
}

export const activePlanTracker = new ActivePlanTracker();

/**
 * 把指定 session 的 active plan 设为 `ref`。
 *
 * - 已存在不同 ref → 覆盖并通知 onChange；
 * - 已存在相同 ref → 幂等（不刷新 createdAt、不通知）。
 */
export function markActivePlan(sessionId: string, ref: PlanRef): void {
  activePlanTracker.mark(sessionId, ref);
}

/**
 * 清除指定 session 的 active plan。
 *
 * - `expectedRef` 给定时仅当当前持有的 ref 与之相等才清除；不一致返 `false`。
 * - 未给 `expectedRef` 时强制清除。
 */
export function clearActivePlan(
  sessionId: string,
  options?: { expectedRef?: PlanRef; reason?: ActivePlanClearReason },
): boolean {
  return activePlanTracker.clear(sessionId, options);
}

/**
 * Readonly 查询：返回指定 session 的 active plan 完整 ref，没有则 null。
 * 过期 entry 原地清理后返回 null。
 */
export function getActivePlanRef(sessionId: string): PlanRef | null {
  return activePlanTracker.getRef(sessionId);
}

/**
 * **guard 专用**：返回 document 载体的 id；file 载体返回 null。
 *
 * plan-mode-guard 的 target 豁免（`tabdoc_update_document` 的 document_id ===
 * active plan id）只对 document 载体有意义——本地 file plan 不通过 tabdoc 写工具
 * 编辑，因此 file 载体返回 null，让这类工具在 plan 模式回归普通软拒。
 */
export function getActivePlan(sessionId: string): string | null {
  return activePlanTracker.getDocumentId(sessionId);
}

/**
 * **reminder 专用**：返回 file 载体的相对路径；document 载体返回 null。
 * host 用它给 plan 模式 per-turn reminder 注入「当前 plan 文件路径」。
 */
export function getActivePlanFilePath(sessionId: string): string | null {
  return activePlanTracker.getFilePath(sessionId);
}

/**
 * Session 完全退出时调用，无视 expectedRef 强制清空。
 * 主要 callsite：host session dispose / runtime 重建 / query abort / rollback pipeline。
 */
export function clearAllForSession(sessionId: string): void {
  activePlanTracker.clearAllForSession(sessionId);
}

/**
 * 调试 / telemetry 辅助接口：当前所有 session 的快照。
 * 调用时顺手扫过期。
 */
export function __snapshotActivePlans(): Array<{ sessionId: string; ref: PlanRef; createdAt: number }> {
  return activePlanTracker.snapshot();
}

/** 注册 active plan 变更观察器（只允许一个）。 */
export function setActivePlanChangeListener(
  cb: ((event: ActivePlanChangeEvent) => void) | undefined,
): void {
  activePlanTracker.setChangeListener(cb);
}

/** **测试专用**：清空全局 Map + 移除观察器。 */
export function __resetActivePlanTrackerForTests(): void {
  activePlanTracker.resetForTests();
}
