/**
 * 类型安全的 metadata 字段访问工具。
 *
 * 替代 `metadata.xxx as string | undefined` 模式，
 * 在运行时进行类型校验，避免 `as` 断言掩盖的类型错误。
 */

type MetaRecord = Record<string, unknown> | undefined | null

export function metaStr(meta: MetaRecord, key: string): string | undefined {
  const v = meta?.[key]
  return typeof v === 'string' ? v : undefined
}

/** 实例自定义 emoji（如文档 icon），空字符串视为未设置 */
export function metaIcon(meta: MetaRecord): string | undefined {
  const icon = metaStr(meta, 'icon')?.trim()
  return icon || undefined
}

export function metaNum(meta: MetaRecord, key: string): number | undefined {
  const v = meta?.[key]
  return typeof v === 'number' ? v : undefined
}

export function metaBool(meta: MetaRecord, key: string): boolean | undefined {
  const v = meta?.[key]
  return typeof v === 'boolean' ? v : undefined
}

export function metaStrArr(meta: MetaRecord, key: string): string[] | undefined {
  const v = meta?.[key]
  return Array.isArray(v) ? v as string[] : undefined
}

export function metaNumOr(meta: MetaRecord, key: string, fallback: number): number {
  const v = meta?.[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/**
 * 资源列表 / 宫格用的展示 emoji：优先实例 metadata.icon，否则回退到类型默认。
 */
export function resolveResourceEmoji(
  itemType: string,
  metadata: MetaRecord,
  getTypeEmoji: (type: string) => string | undefined,
  fallback = '📁',
): string {
  return metaIcon(metadata) || getTypeEmoji(itemType) || fallback
}
