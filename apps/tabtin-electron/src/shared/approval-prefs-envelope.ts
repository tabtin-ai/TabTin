/**
 * 审批偏好 WS 信封解包（设置 IA SIA-4）—— renderer 侧纯函数。
 *
 * 后端 `_broadcast_approval_preferences_changed`（profile_routes.py）用
 * `build_envelope("approval_preferences_changed", id, {"data": preferences})`
 * 广播。`build_envelope` 把第 3 个位置参数原样放进 `envelope.payload`
 * （见 services/common/ws/protocol.py），故 renderer 的 WS listener 实际收到的
 * 信封形如：
 *
 *     { type: "approval_preferences_changed", payload: { data: preferences }, ... }
 *
 * —— `preferences`（`{ <scopeKey>: {approved, updatedAt} }` 扁平 map）被
 * `payload` + `data` 两层包裹。下游 `approvalScopeCache.syncFromRemote` 期望的正是
 * 那张扁平 map；旧实现 `envelope.data ?? envelope.payload` 取到的却是
 * `{ data: preferences }`（多包一层）—— syncFromRemote 逐项要求 `entry.approved`
 * 为 boolean，整张 `preferences` 显然不满足 → 全部跳过 → WS 实时同步静默 no-op，
 * 只剩启动 / 登录时的 HTTP 拉取兜底。
 *
 * 修复：先剥 `payload.data`（与 Phase 2 `unwrapUISettingsMap` 的 payload→data
 * 解包同款思路），再回退 `payload` / 顶层 `data` 兼容其它形态。返回扁平 map
 * 或 `null`（缺失 / 非对象时不喂垃圾给下游）。
 */
export function unwrapApprovalPreferences(
  envelope: unknown,
): Record<string, unknown> | null {
  if (!envelope || typeof envelope !== 'object') return null
  const env = envelope as Record<string, unknown>
  const payload = env.payload
  const payloadData =
    payload && typeof payload === 'object'
      ? (payload as Record<string, unknown>).data
      : undefined
  // 优先级与修复式一致：payload.data → payload → 顶层 data。
  //
  // 回退分支的理论歧义（现实风险极低，仅注释提示）：当前后端
  // _broadcast_approval_preferences_changed 恒包 {"data": preferences}，故 payload.data
  // 永远命中、无歧义。但若后端将来改成不再包 data 壳、且某 scopeKey 恰好叫 "data"，
  // payload.data 会误取那一条 entry 而非整张 preferences map。scopeKey 是 actionType
  // 形态（execute_in_terminal / write_file:src/components 之类），出现字面量 "data" 作
  // key 的概率极低；真要改这条 WS 协议时应同步收敛此处的解包顺序。
  const data = payloadData ?? payload ?? env.data
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : null
}
