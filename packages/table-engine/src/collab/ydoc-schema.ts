/**
 * TabData Y.Doc 数据模型 — Key 常量
 *
 * Y.Doc 结构：
 *   records      Y.Map<recordId, Y.Map<fieldIdHex, cellValue>>  — 行数据；可稀疏含 __position_id
 *   rowOrder     Y.Array<recordId>                              — 行顺序（旧，向后兼容）
 *   rowOrderMap  Y.Map<recordId, position>                      — legacy 行序投影（LWW）
 *   views        Y.Map<viewId, ViewMeta-like object>            — 视图定义（筛选/排序/分组/列配置）
 *   viewOrderMap Y.Map<viewId, position>                        — 视图标签顺序
 *   meta         Y.Map                                          — fields, version, table_name, table_id
 *
 * 本文件不依赖 yjs，仅导出字符串常量。
 * 使用方通过 `ydoc.getMap(YDOC_RECORDS)` 等方式引用。
 */

export const YDOC_RECORDS = 'records';
export const YDOC_ROW_ORDER = 'rowOrder';
export const YDOC_ROW_ORDER_MAP = 'rowOrderMap';
export const YDOC_VIEWS = 'views';
export const YDOC_VIEW_ORDER_MAP = 'viewOrderMap';
export const YDOC_META = 'meta';
