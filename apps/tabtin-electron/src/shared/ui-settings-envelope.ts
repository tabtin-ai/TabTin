/**
 * 个人偏好同步信封归一（设置 IA Phase 2）—— main / renderer **共享**纯函数。
 *
 * 后端对个人偏好的 GET/PUT/WS 用了不同层级的封装，前端两端必须按同一套规则
 * 解包，否则会出现"一端能读、另一端读到 null"的不一致（曾因 main 侧漏 unwrap
 * 成功外壳的 data 层，把 GET 当成"服务器没有偏好"，进而把 DEFAULT 推回服务器、
 * 静默清空用户通知偏好并跨设备扩散 —— 阻断级数据完整性事故）。
 *
 * 实测各形态（与 2A 后端 `profile_routes.py` 对齐）：
 *   - GET 裸响应（main 走 `net.fetch` + `resp.json()` 拿到的原始体）：
 *       `{ success, code, message, data: { settings: { <ns>: {value, updatedAt} } } }`
 *   - GET 经 `apiService.request`（renderer，已自动剥一层 `data`）：
 *       `{ settings: { <ns>: {value, updatedAt} } }`
 *   - WS `ui_settings_changed` envelope（`build_envelope(..., {"data": {"settings": ...}})`）：
 *       `{ type, payload: { data: { settings: {...} } } }`
 *   - 兜底：直接就是 `{ <ns>: {value, updatedAt} }`
 *
 * 统一按 `payload → data → settings` 依次 unwrap，得到 `ns → {value, updatedAt}` 的扁平 map。
 *
 * ⚠️ 单一事实源：renderer（`stores/uiSettingsSync.ts`）与 main
 * （`main/services/notification/prefs-store.ts`）**都**复用本函数，严禁任一端再造
 * 一套不同的解包逻辑。
 */

export interface UISettingEnvelopeLike {
  value: unknown
  updatedAt: number
}

function unwrap(node: unknown, key: string): unknown {
  if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
    const inner = (node as Record<string, unknown>)[key]
    if (inner && typeof inner === 'object') return inner
  }
  return node
}

/**
 * 把任意上述形态归一成 `ns → {value, updatedAt}` 扁平 map（updatedAt 缺失/非数兜底 0）。
 * 只返回形如 `{value, ...}` 的条目；调用方各自挑自己关心的 namespace。
 */
export function unwrapUISettingsMap(input: unknown): Record<string, UISettingEnvelopeLike> {
  if (!input || typeof input !== 'object') return {}

  let node: unknown = input
  node = unwrap(node, 'payload') // WS envelope.payload
  node = unwrap(node, 'data') // {success, data:{...}} 成功外壳（main 裸 fetch 必经）
  node = unwrap(node, 'settings') // {settings:{...}} 契约包裹

  const source = (node && typeof node === 'object' ? node : {}) as Record<string, unknown>
  const out: Record<string, UISettingEnvelopeLike> = {}
  for (const [namespace, entry] of Object.entries(source)) {
    if (entry && typeof entry === 'object' && 'value' in (entry as Record<string, unknown>)) {
      const rawUpdatedAt = (entry as Record<string, unknown>).updatedAt
      const updatedAt =
        typeof rawUpdatedAt === 'number' && Number.isFinite(rawUpdatedAt) ? rawUpdatedAt : 0
      out[namespace] = { value: (entry as Record<string, unknown>).value, updatedAt }
    }
  }
  return out
}
