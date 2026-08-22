/**
 * bulk-update 的 advisory 冲突提示文案。
 *
 * 服务端在写入成功的同时会回报「你提交的字段在你编辑期间被别人改过」，
 * 写入不会被拒绝。这里只负责把 conflicts 翻译成一句人话，与移动端
 * `TabDataBulkUpdatePolicy.conflictFieldNames` 保持同一套口径：去重、
 * 最多列两个字段名、超出部分折叠成总数。
 *
 * 引号与分隔符一律走 i18n 模板，不在代码里拼——中文的「」顿号在英文
 * 界面下会渲染成乱七八糟的样子。
 */

export interface AdvisoryConflict {
  record_id: string
  field_id: string
  your_value: unknown
  server_value: unknown
}

interface NamedField {
  id: string
  name: string
}

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 与移动端 `CONFLICT_NAME_LIMIT` 对齐。 */
export const CONFLICT_NAME_LIMIT = 2

export interface AdvisoryConflictSummary {
  /** 展示用的字段名，已去重并截断到上限。 */
  listed: string[]
  /** 去重后的冲突字段总数。 */
  total: number
}

/**
 * 把冲突列表归并成字段名。字段找不到时退回 field_id——宁可露出一个
 * 陌生标识，也好过让用户不知道哪一列被改了。
 */
export function summarizeAdvisoryConflicts(
  conflicts: AdvisoryConflict[],
  fields: NamedField[],
  maxNames: number = CONFLICT_NAME_LIMIT,
): AdvisoryConflictSummary {
  const nameById = new Map(fields.map(field => [field.id, field.name]))
  const names: string[] = []
  for (const conflict of conflicts) {
    const name = nameById.get(conflict.field_id) ?? conflict.field_id
    if (!names.includes(name)) {
      names.push(name)
    }
  }
  return {
    listed: names.slice(0, Math.max(1, maxNames)),
    total: names.length,
  }
}

/**
 * 生成 toast 描述文案；无冲突时返回 null，调用方据此决定是否弹提示。
 */
export function describeAdvisoryConflicts(
  conflicts: AdvisoryConflict[],
  fields: NamedField[],
  t: Translate,
  maxNames: number = CONFLICT_NAME_LIMIT,
): string | null {
  if (conflicts.length === 0) {
    return null
  }

  const { listed, total } = summarizeAdvisoryConflicts(conflicts, fields, maxNames)
  if (listed.length === 0) {
    return null
  }

  const separator = t('table:collab.conflictFieldSeparator')
  const fieldNames = listed.join(separator)

  return total > listed.length
    ? t('table:collab.conflictFieldsChanged', { fieldNames, count: total })
    : t('table:collab.conflictFieldChanged', { fieldNames })
}
