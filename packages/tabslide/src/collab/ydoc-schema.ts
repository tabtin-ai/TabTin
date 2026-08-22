/**
 * TabSlide Y.Doc 数据模型
 *
 * Y.Doc 结构：
 *   pages          Y.Map<pageId, Y.Map>          — 每页数据（含 elementsMap、elementOrder 等）
 *   pageOrder      Y.Array<pageId>               — 页面顺序（旧格式，双写兼容保留）
 *   pageOrderMap   Y.Map<pageId, string>           — 页面顺序（fractional index，并发安全）
 *   meta           Y.Map                         — version, slide_name, slide_id, theme, font_meta 等
 *
 * 页面 Y.Map 内部结构：
 *   elementsMap      Y.Map<elementId, Y.Map>      — 元素扁平映射（新格式，属性级 CRDT）
 *   elementOrder     Y.Array<elementId>           — 元素排序（旧格式，双写兼容保留）
 *   elementOrderMap  Y.Map<elementId, string>     — 元素排序（fractional index，并发安全）
 *   elements         Y.Array                     — 兼容旧格式（PPTElement 数组）
 *   background, remark, turningMode, layout, masterElements, animations,
 *   notes (Y.Array<SlideNote>), sectionTag, slideType...
 */

import * as Y from 'yjs';

// ─── Y.Doc Map/Array 名称常量 ─────────────────────────────

export const YDOC_PAGES = 'pages';
export const YDOC_PAGE_ORDER = 'pageOrder';
/** 新格式：Y.Map<pageId, string>，key=pageId, value=fractional index */
export const YDOC_PAGE_ORDER_MAP = 'pageOrderMap';
export const YDOC_META = 'meta';

// ─── 页面内部 key ──────────────────────────────────────────

export const PAGE_ELEMENTS_MAP = 'elementsMap';
export const PAGE_ELEMENT_ORDER = 'elementOrder';
/** 新格式：Y.Map<elementId, string>，key=elementId, value=fractional index */
export const PAGE_ELEMENT_ORDER_MAP = 'elementOrderMap';
export const PAGE_ELEMENTS_LEGACY = 'elements';

// ─── 访问器 ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- yjs version mismatch between root and package node_modules
export function getPagesMap(ydoc: any): Y.Map<unknown> {
  return ydoc.getMap(YDOC_PAGES);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPageOrderArray(ydoc: any): Y.Array<string> {
  return ydoc.getArray(YDOC_PAGE_ORDER);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getPageOrderMap(ydoc: any): Y.Map<string> {
  return ydoc.getMap(YDOC_PAGE_ORDER_MAP);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getMetaMap(ydoc: any): Y.Map<unknown> {
  return ydoc.getMap(YDOC_META);
}

/**
 * 获取指定页面的 Y.Map。
 * 不存在时返回 null。
 */
export function getPageYMap(
  pagesMap: Y.Map<unknown>,
  pageId: string,
): Y.Map<unknown> | null {
  const val = pagesMap.get(pageId);
  return val instanceof Y.Map ? val : null;
}
