/**
 * 编译期类型兼容性测试
 *
 * 确保 @tabtin/table-core 的类型可以直接赋值给 @tabtin/table-ui 的对应类型。
 * 无运行时代码，仅由 tsc 编译期检查。
 */

import type {
  Field as CoreField,
  FieldOptions as CoreFieldOptions,
  ViewMeta as CoreViewMeta,
  ViewRecordsResponse as CoreViewRecordsResponse,
  ViewFilter as CoreViewFilter,
  ViewSort as CoreViewSort,
  ViewGroup as CoreViewGroup,
  TableRecord as CoreTableRecord,
} from '@tabtin/table-core'

import type {
  Field as UiField,
  FieldOptions as UiFieldOptions,
  ViewMeta as UiViewMeta,
  ViewRecordsResponse as UiViewRecordsResponse,
  ViewFilter as UiViewFilter,
  ViewSort as UiViewSort,
  ViewGroup as UiViewGroup,
  TableRecord as UiTableRecord,
} from '../types'

/* ── FieldOptions: table-core → table-ui ── */
declare const _coreFieldOptions: CoreFieldOptions
export const _uiFieldOptions: UiFieldOptions = _coreFieldOptions

/* ── Field: table-core → table-ui ── */
declare const _coreField: CoreField
export const _uiField: UiField = _coreField

/* ── ViewFilter: table-core → table-ui ── */
declare const _coreViewFilter: CoreViewFilter
export const _uiViewFilter: UiViewFilter = _coreViewFilter

/* ── ViewSort: table-core → table-ui ── */
declare const _coreViewSort: CoreViewSort
export const _uiViewSort: UiViewSort = _coreViewSort

/* ── ViewGroup: table-core → table-ui ── */
declare const _coreViewGroup: CoreViewGroup
export const _uiViewGroup: UiViewGroup = _coreViewGroup

/* ── TableRecord: table-core → table-ui ── */
declare const _coreTableRecord: CoreTableRecord
export const _uiTableRecord: UiTableRecord = _coreTableRecord

/* ── ViewMeta: table-core → table-ui ── */
declare const _coreViewMeta: CoreViewMeta
export const _uiViewMeta: UiViewMeta = _coreViewMeta

/* ── ViewRecordsResponse: table-core → table-ui ── */
declare const _coreViewRecordsResponse: CoreViewRecordsResponse
export const _uiViewRecordsResponse: UiViewRecordsResponse = _coreViewRecordsResponse
