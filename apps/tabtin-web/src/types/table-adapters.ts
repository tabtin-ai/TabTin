/**
 * Type adapters and i18n helpers.
 *
 * ViewMeta / ViewGroup / ViewType / Field / FieldOptions 已统一
 * (table-ui re-exports table-core)。
 */

import {
  buildColumnMetaUpdatePayload as buildSharedColumnMetaUpdatePayload,
  type ViewColumnMeta,
  type ViewUpdateRequest,
} from '@tabtin/table-core'

export type TranslateFunction = (key: string, options?: Record<string, unknown>) => string
type LooseI18nLike = {
  t: {
    (key: string | string[], options?: Record<string, unknown>): unknown
    (key: string | string[], defaultValue: string, options?: Record<string, unknown>): unknown
  }
}

/**
 * 优先传入 useTranslation(...) 返回的 t（首个 ns 为默认命名空间）。
 * 若传 i18n 实例，会走全局 defaultNS（Web 为 common），无前缀的 view 键会 miss。
 */
export function createLooseTranslate(
  i18nOrT: LooseI18nLike | TranslateFunction,
): TranslateFunction {
  if (typeof i18nOrT === 'function') {
    return (key: string, options?: Record<string, unknown>) => String(i18nOrT(key, options))
  }
  return (key: string, options?: Record<string, unknown>) =>
    String(i18nOrT.t(key, options))
}

export function buildColumnMetaUpdatePayload(
  columnMeta: ViewColumnMeta,
): Pick<ViewUpdateRequest, 'column_meta'> {
  return buildSharedColumnMetaUpdatePayload(columnMeta)
}
