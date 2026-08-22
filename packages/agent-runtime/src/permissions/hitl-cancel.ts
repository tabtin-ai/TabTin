/**
 * HITL pending approval 取消 — Phase 3 mode 切换时清理 stale dialog。
 *
 * 主进程 `pendingHitlRequests` 存的是 batchId → `{ sessionId, resolver }`；
 * 取消时按 sessionId 过滤，只解 resolve 对应 session 的 batch，
 * 把对应 batch 从 map 删除并 resolve 一份 deny payload，
 * 让 runtime LocalPermissionHandler 走 catch → 整批 deny。
 *
 * Phase 3 F1 修复（2026-05-28）：旧版本不带 sessionId，跨 session 误杀。
 * 现在三种调用方式：
 *   - `cancelAllPendingHitlRequests({ hitlMap, sessionId: 'sess-A' })`：仅 sess-A
 *   - `cancelAllSessionsHitlRequests({ hitlMap })`：全局（仅 shutdown 用）
 *   - 旧 `cancelAllPendingHitlRequests({ hitlMap })`：等价于全局（**已 @deprecated**，
 *     仅留给迁移期 daemon 类宿主向后兼容；新代码必须传 sessionId）
 */

/** Pending HITL map 单条 entry：把 batchId 与 sessionId 绑定。 */
export interface PendingHitlEntry {
  /** session 隔离 key——主进程多 session 共用一个进程级 map 时按它过滤。 */
  sessionId: string;
  /** runtime LocalPermissionHandler 注入的 resolve 回调。 */
  resolver: (response: unknown) => void;
}

/**
 * 主进程级 HITL pending map：key=batchId / requestId（共用同一空间），
 * value 携带 sessionId 元信息以支持按 session 取消。
 */
export type PendingHitlMap = Map<string, PendingHitlEntry>;

export interface CancelAllPendingHitlOptions {
  hitlMap: PendingHitlMap;
  /**
   * 当传入时仅 cancel 该 session 的 batch；省略 → 全局清空（**仅 shutdown / 测试**）。
   *
   * 生产路径（mode soft-reconfigure / mode-switch 批准 / UI 切 mode）必须传，
   * 否则会跨 session 误杀其它 session 正在等审批的 batch。
   */
  sessionId?: string;
  reason?: string;
}

/**
 * 取消 pending HITL batch（默认按 session 过滤）。
 * @returns 被取消的 batchId 列表
 */
export function cancelAllPendingHitlRequests(
  options: CancelAllPendingHitlOptions,
): string[] {
  const cancelled: string[] = [];
  const reason =
    options.reason ??
    'Pending tool approval cancelled because agent mode changed.';

  for (const [batchId, entry] of options.hitlMap.entries()) {
    if (options.sessionId !== undefined && entry.sessionId !== options.sessionId) {
      continue;
    }
    options.hitlMap.delete(batchId);
    try {
      entry.resolver({
        batch_id: batchId,
        decisions: [
          {
            request_id: '__mode_switch_cancel__',
            tool_call_id: '__mode_switch_cancel__',
            outcome: 'cancelled',
            rejection_message: reason,
          },
        ],
      });
    } catch {
      // resolver 不应抛；防御性忽略
    }
    cancelled.push(batchId);
  }
  return cancelled;
}

/**
 * 全局清空所有 session 的 pending HITL（**仅** Host shutdown / 进程退出场景调用）。
 *
 * 等价于 `cancelAllPendingHitlRequests({ hitlMap })`（不带 sessionId）；
 * 显式命名是为了让调用点意图清晰——不要在业务路径（mode 切换 / soft-reconfigure）
 * 误用这个全局变体，否则会跨 session 误杀。
 */
export function cancelAllSessionsHitlRequests(
  options: Omit<CancelAllPendingHitlOptions, 'sessionId'>,
): string[] {
  return cancelAllPendingHitlRequests({ ...options });
}
