/**
 * 记录数据「变更子集」计算。
 *
 * 编辑记录对话框的 formData 携带整条记录的全部可见字段（含自动编号、创建人、
 * 创建时间等系统托管/计算字段）。若提交时整条回传，后端 bulk_update 一旦发现
 * patch 内含系统托管字段，会整条拒绝（而非仅跳过那几个 key），导致用户真正改动
 * 的业务字段一起保存失败。提交前用本函数 diff 出用户实际改动的字段，未改动的
 * （含系统字段）不发，从根上避免整条被拒。
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

export interface ComputeChangedRecordDataOptions {
  /**
   * 不参与 diff 的字段 key（按 ``next`` 的 key 空间，通常是字段名）。
   *
   * 用于排除「带外管理」字段（附件 / 多媒体）：它们的值不随记录主体读写，而是经各自
   * 专属 API 即时落库、编辑对话框打开时才懒加载回填到 formData。基线 ``record.data``
   * 永远缺这些 key，懒加载又让 ``next`` 凭空多出它们，若参与 diff 会被恒判为「改动」
   * 并整条回传未改动的附件载荷——既违反 PATCH 语义，又会在附件尚未关联到记录时触发
   * 后端整条拒绝（表现为「这条记录改不动」）。
   */
  ignoreKeys?: Iterable<string>
}

/**
 * 返回 ``next`` 中与 ``base`` 不同的字段子集（按 ``next`` 的 key 空间）。
 *
 * - 仅遍历 ``next`` 的 key：base 中存在但 next 中没有的 key 不会被当作「清空」，
 *   编辑对话框的 formData 始终携带全部字段，故无需处理删除语义。
 * - 值比较用深比较，覆盖多选/关联/附件等数组与对象型字段，避免「引用变了但值没变」
 *   被误判为改动。
 * - ``options.ignoreKeys`` 中的 key 直接跳过（见 ``ignoreKeys`` 说明）。
 */
export const computeChangedRecordData = (
  next: Record<string, unknown>,
  base: Record<string, unknown> | null | undefined,
  options?: ComputeChangedRecordDataOptions,
): Record<string, unknown> => {
  const baseline = base ?? {}
  const ignore = options?.ignoreKeys ? new Set(options.ignoreKeys) : null
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(next ?? {})) {
    if (ignore?.has(key)) continue
    if (!deepEqual(next[key], baseline[key])) {
      changed[key] = next[key]
    }
  }
  return changed
}
