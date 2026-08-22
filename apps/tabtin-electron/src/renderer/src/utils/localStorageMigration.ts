/**
 * localStorage 旧全局 key → organization 命名空间 key 一次性迁移辅助。
 *
 * Wave 5 二次续作把若干 localStorage key 加 organizationId 命名空间(避免跨 organization
 * 全局污染),fallback 读旧全局 key 向后兼容。但 toggle 后只写新 key,不清旧 key,
 * 旧数据永久残留 localStorage —— 无功能影响,但脏数据。
 *
 * Wave 8 治理:本 helper 在组件首次挂载时调一次,把旧 key 的值搬到新 key 并删旧 key,
 * 让本地存储干净;若新 key 已存在则保留新 key 值 + 删旧 key(不覆盖用户后续偏好)。
 *
 * 设计取舍:
 *   - 同步执行(localStorage 本身同步)
 *   - 任何 localStorage 异常都吞掉(隐私模式 / quota / 沙箱场景)——失败比崩溃可接受
 *   - 不抛异常、不返回 promise——caller 直接在 useEffect 里 fire-and-forget
 */

/**
 * 把旧全局 key 的值迁移到新 organization 命名空间 key。
 *
 * 行为矩阵:
 *   - 旧 key 存在 + 新 key 不存在 → 写新 key(取旧 key 的值)+ 删旧 key
 *   - 旧 key 存在 + 新 key 也存在 → 保留新 key + 删旧 key(不覆盖)
 *   - 旧 key 不存在 → noop
 *
 * @param legacyKey 旧的全局 localStorage key(如 `tabtin:chat-sidebar:trackers-collapsed`)
 * @param namespacedKey 新的 organization 命名空间 key(如 `tabtin:chat-sidebar:trackers-collapsed:<organizationId>`)
 */
export function migrateLegacyLocalStorageKey(legacyKey: string, namespacedKey: string): void {
  // 同 key 直接 noop —— 不可能也不应迁移
  if (legacyKey === namespacedKey) return
  try {
    const legacyValue = localStorage.getItem(legacyKey)
    if (legacyValue === null) {
      // 旧 key 不存在 → noop(用户从未保存过偏好,或已经迁移过)
      return
    }
    const existingNamespacedValue = localStorage.getItem(namespacedKey)
    if (existingNamespacedValue === null) {
      // 新 key 不存在 → 把旧值搬过去
      localStorage.setItem(namespacedKey, legacyValue)
    }
    // 无论新 key 是否已存在,旧 key 都该清掉(已迁移完成 / 用户已有更新偏好)
    localStorage.removeItem(legacyKey)
  } catch {
    // localStorage 不可用(隐私模式 / quota / 沙箱) — fail silent
  }
}
