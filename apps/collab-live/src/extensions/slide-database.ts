/**
 * Slide Database Extension
 *
 * TabSlide 的 Hocuspocus 持久化扩展，继承 BaseCollabDatabase。
 *
 * Y.Doc 数据模型:
 *   pages:        Y.Map<pageId, Y.Map<string, any>>
 *   pageOrderMap: Y.Map<pageId, number>  — 页面排序（主数据源，LWW）
 *   pageOrder:    Y.Array<pageId>        — [DEPRECATED] 仅用于旧客户端 fallback 读取
 *   meta:         Y.Map  (version, project_name, canvas_width, canvas_height, preset, theme)
 */

import * as Y from "yjs";
import { BaseCollabDatabase, type PersistPayload } from "./base-collab-database.js";
import { extractEditorInfo } from "../lib/collab-utils.js";
import { getOrderedIds, setOrderedIds } from "../lib/y-utils.js";

const YDOC_PAGES = "pages";
const YDOC_PAGE_ORDER = "pageOrder";
const YDOC_META = "meta";
const YDOC_PAGE_ORDER_MAP = "pageOrderMap";
const PAGE_ELEMENT_ORDER_MAP = "elementOrderMap";

interface PageDigest {
  contentHash: string;
}

interface SlideSnapshot {
  pageDigests: Map<string, PageDigest>;
  pageOrder: string[];
  meta?: { theme?: unknown; name?: string; font_meta?: unknown };
}

/** SLD-002: 并发 Y.Array delete+push 合并后可能产生重复，消费时去重 */
function deduplicateStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

let singletonInstance: SlideDatabase | null = null;

function plainValueToY(value: unknown): unknown {
  if (value instanceof Y.Map || value instanceof Y.Array) return value;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    const map = new Y.Map<unknown>();
    for (const [key, child] of Object.entries(value)) {
      map.set(key, plainValueToY(child));
    }
    return map;
  }
  return value;
}

function normalizeSnapshotPage(page: Record<string, unknown>, pageId: string): Record<string, unknown> {
  return {
    ...page,
    id: pageId,
    elements: Array.isArray(page.elements) ? page.elements : [],
    masterElements: Array.isArray(page.masterElements)
      ? page.masterElements
      : (Array.isArray(page.master_elements) ? page.master_elements : []),
    notes: Array.isArray(page.notes)
      ? page.notes
      : (Array.isArray(page.slide_notes) ? page.slide_notes : []),
    sectionTag: page.sectionTag ?? page.section_tag,
    slideType: page.slideType ?? page.slide_type,
    remark: page.remark ?? page.notes,
  };
}

/**
 * 从 Y.Map 页面转换为 JSON 对象
 */
function yPageToJson(pageYMap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const elementsMap = pageYMap.get("elementsMap");
  const elementOrderMap = pageYMap.get(PAGE_ELEMENT_ORDER_MAP);
  const elementOrder = pageYMap.get("elementOrder");

  if (elementsMap instanceof Y.Map) {
    let orderedIds: string[];
    if (elementOrderMap instanceof Y.Map && elementOrderMap.size > 0) {
      orderedIds = getOrderedIds(elementOrderMap as Y.Map<number>);
    } else if (elementOrder instanceof Y.Array) {
      const raw: string[] = [];
      for (let i = 0; i < elementOrder.length; i++) raw.push(elementOrder.get(i) as string);
      orderedIds = deduplicateStrings(raw);
    } else {
      orderedIds = [];
    }
    const ordered: unknown[] = [];
    for (const elId of orderedIds) {
      const elYMap = elementsMap.get(elId);
      if (elYMap instanceof Y.Map) {
        ordered.push(elYMap.toJSON());
      }
    }
    result.elements = ordered;
  } else {
    const elements = pageYMap.get("elements");
    result.elements = elements instanceof Y.Array ? elements.toJSON() : [];
  }

  for (const key of ["background", "remark", "turningMode", "layout"] as const) {
    const val = pageYMap.get(key);
    if (val !== undefined) result[key] = val;
  }

  for (const key of ["masterElements", "animations", "notes"] as const) {
    const val = pageYMap.get(key);
    if (val instanceof Y.Array) result[key] = val.toJSON();
  }

  return result;
}

/**
 * SLD-003: 页面内容双哈希摘要（FNV-1a + djb2），提供 64-bit 碰撞抗性。
 * 直接遍历 Y.Map 结构计算哈希，避免创建 yPageToJson 的中间结果对象，
 * 用 O(1) 字符串 === 替代 O(N×M) 递归 deepEqual，大幅降低 CPU 和内存开销。
 */
function hashPageContent(pageYMap: Y.Map<unknown>): string {
  let h1 = 2166136261;
  let h2 = 5381;

  const feed = (c: number) => {
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = ((h2 << 5) + h2 + c) | 0;
  };

  const feedStr = (str: string) => {
    for (let i = 0; i < str.length; i++) feed(str.charCodeAt(i));
    feed(0x1f);
  };

  const elementsMap = pageYMap.get("elementsMap");
  const elementOrderMap = pageYMap.get(PAGE_ELEMENT_ORDER_MAP);
  const elementOrder = pageYMap.get("elementOrder");

  if (elementsMap instanceof Y.Map) {
    let orderedIds: string[];
    if (elementOrderMap instanceof Y.Map && elementOrderMap.size > 0) {
      orderedIds = getOrderedIds(elementOrderMap as Y.Map<number>);
    } else if (elementOrder instanceof Y.Array) {
      const raw: string[] = [];
      for (let i = 0; i < elementOrder.length; i++) raw.push(elementOrder.get(i) as string);
      orderedIds = deduplicateStrings(raw);
    } else {
      orderedIds = [];
    }

    feedStr(`E${orderedIds.length}`);
    for (const elId of orderedIds) {
      feedStr(elId);
      const elYMap = elementsMap.get(elId);
      if (elYMap instanceof Y.Map) {
        feedStr(JSON.stringify(elYMap.toJSON()));
      }
    }
  } else {
    const elements = pageYMap.get("elements");
    if (elements instanceof Y.Array) {
      feedStr("e");
      feedStr(JSON.stringify(elements.toJSON()));
    }
  }

  for (const key of ["background", "layout", "remark", "turningMode"] as const) {
    const val = pageYMap.get(key);
    if (val !== undefined) {
      feedStr(key);
      feedStr(
        val === null ? "\x01null" :
        val === undefined ? "\x01undef" :
        typeof val === "string" ? val :
        JSON.stringify(val),
      );
    }
  }

  for (const key of ["animations", "masterElements", "notes"] as const) {
    const val = pageYMap.get(key);
    if (val instanceof Y.Array) {
      feedStr(key);
      feedStr(JSON.stringify(val.toJSON()));
    }
  }

  return `${h1 >>> 0}:${h2 >>> 0}`;
}

export class SlideDatabase extends BaseCollabDatabase {
  /**
   * SLD-003: buildPersistPayload 暂存已计算的摘要，供 onStoreSuccess 复用，
   * 避免二次全量哈希计算。按 documentName 索引以支持多文档并发。
   */
  private readonly _pendingSnapshots = new Map<string, SlideSnapshot>();

  constructor() {
    super();
    if (singletonInstance) console.warn("[SlideDB] Singleton already exists, overwriting");
    singletonInstance = this;
  }

  protected getPrefix(): string { return "slide:"; }
  protected getResourceType(): string { return "slide"; }
  protected getModuleLabel(): string { return "SlideDB"; }

  /** 保存 Y.Doc 当前状态为 diff 快照（digest 模式，不存储完整页面数据） */
  saveSnapshot(documentName: string, ydoc: Y.Doc): void {
    const pagesMap = ydoc.getMap(YDOC_PAGES);
    const metaMap = ydoc.getMap(YDOC_META);

    const pageDigests = new Map<string, PageDigest>();
    pagesMap.forEach((value, pageId) => {
      if (value instanceof Y.Map) {
        pageDigests.set(pageId, { contentHash: hashPageContent(value) });
      }
    });

    const pageOrderMapY = ydoc.getMap(YDOC_PAGE_ORDER_MAP);
    let pageOrder: string[];
    if (pageOrderMapY.size > 0) {
      pageOrder = getOrderedIds(pageOrderMapY);
    } else {
      const pageOrderArr = ydoc.getArray<string>(YDOC_PAGE_ORDER);
      const rawPageOrder: string[] = [];
      for (let i = 0; i < pageOrderArr.length; i++) rawPageOrder.push(pageOrderArr.get(i));
      pageOrder = deduplicateStrings(rawPageOrder);
    }

    const theme = metaMap.get("theme");
    const projectName = metaMap.get("project_name");
    const fontMeta = metaMap.get("font_meta");
    const meta: { theme?: unknown; name?: string; font_meta?: unknown } = {};
    if (theme !== undefined) meta.theme = theme;
    if (typeof projectName === "string") meta.name = projectName;
    if (fontMeta !== undefined) meta.font_meta = fontMeta;

    this.snapshotCache.set(documentName, { pageDigests, pageOrder, meta } satisfies SlideSnapshot);
  }

  protected applySnapshotToDoc(initDoc: Y.Doc, snapshot: Record<string, unknown>): void {
    const pagesMap = initDoc.getMap(YDOC_PAGES);
    const pages = (snapshot.pages || []) as Record<string, unknown>[];
    for (const page of pages) {
      const pageId = page.id as string | undefined;
      if (!pageId) continue;
      const normalizedPage = normalizeSnapshotPage(page, pageId);

      const pageYMap = new Y.Map<unknown>();

      // step4: elementsMap + elementOrderMap（Y.Map 为主数据源，移除 elementOrder Y.Array 双写）
      // 旧客户端只写 elementOrder Y.Array 时，yPageToJson 的 fallback 路径仍可读取（向后兼容）
      const elMap = new Y.Map<Y.Map<unknown>>();
      const orderIds: string[] = [];
      if (Array.isArray(normalizedPage.elements)) {
        for (const el of normalizedPage.elements as Record<string, unknown>[]) {
          if (el.id && typeof el.id === "string") {
            elMap.set(el.id, plainValueToY(el) as Y.Map<unknown>);
            orderIds.push(el.id);
          }
        }
      }
      const elOrderMap = new Y.Map<number>();
      for (let i = 0; i < orderIds.length; i++) elOrderMap.set(orderIds[i], i);
      pageYMap.set("elementsMap", elMap);
      pageYMap.set(PAGE_ELEMENT_ORDER_MAP, elOrderMap);

      for (const key of ["background", "remark", "turningMode", "layout", "sectionTag", "slideType"] as const) {
        if (normalizedPage[key] !== undefined) pageYMap.set(key, normalizedPage[key]);
      }

      for (const key of ["masterElements", "animations", "notes"] as const) {
        if (Array.isArray(normalizedPage[key])) {
          const arr = new Y.Array<unknown>();
          for (const item of normalizedPage[key] as unknown[]) arr.push([plainValueToY(item)]);
          pageYMap.set(key, arr);
        }
      }

      pagesMap.set(pageId, pageYMap);
    }

    // step4: 只写 Y.Map，移除 Y.Array 双写
    // 旧客户端只写 Y.Array 时，syncArrayToMap 会在读取路径自动补齐 Y.Map（向后兼容）
    const pageOrderIds = (snapshot.page_order || []) as string[];
    const pageOrderMap = initDoc.getMap(YDOC_PAGE_ORDER_MAP);
    setOrderedIds(pageOrderMap, pageOrderIds);

    const meta = initDoc.getMap(YDOC_META);
    meta.set("version", snapshot.version);
    meta.set("project_name", snapshot.project_name);
    meta.set("project_id", snapshot.project_id);
    meta.set("canvas_width", snapshot.canvas_width);
    meta.set("canvas_height", snapshot.canvas_height);
    if (snapshot.preset) meta.set("preset", snapshot.preset);
    if (snapshot.theme) meta.set("theme", snapshot.theme);
    if (snapshot.font_meta) meta.set("font_meta", snapshot.font_meta);
  }

  protected onSnapshotLoaded(documentName: string, initDoc: Y.Doc): void {
    this.saveSnapshot(documentName, initDoc);
  }

  protected prepareYDocForMerge(ydoc: Y.Doc, _snapshot?: Record<string, unknown>): void {
    // pageOrderMap: Y.Map 清空，确保 merge 时 Django 快照覆盖
    const existingPageOrderMap = ydoc.getMap(YDOC_PAGE_ORDER_MAP);
    if (existingPageOrderMap.size > 0) {
      ydoc.transact(() => {
        const keys: string[] = [];
        existingPageOrderMap.forEach((_: unknown, k: string) => keys.push(k));
        for (const k of keys) existingPageOrderMap.delete(k);
      });
    }

    const existingPages = ydoc.getMap(YDOC_PAGES);
    existingPages.forEach((value, _pageId) => {
      if (!(value instanceof Y.Map)) return;
      const pageMap = value as Y.Map<unknown>;
      ydoc.transact(() => {
        // elementOrderMap: Y.Map 清空
        const elOrderMap = pageMap.get(PAGE_ELEMENT_ORDER_MAP);
        if (elOrderMap instanceof Y.Map && elOrderMap.size > 0) {
          const mapKeys: string[] = [];
          elOrderMap.forEach((_: unknown, key: string) => { mapKeys.push(key); });
          for (const k of mapKeys) elOrderMap.delete(k);
        }
        for (const key of ["elements", "masterElements", "animations", "notes"]) {
          const arr = pageMap.get(key);
          if (arr instanceof Y.Array && arr.length > 0) arr.delete(0, arr.length);
        }
        const elemMap = pageMap.get("elementsMap");
        if (elemMap instanceof Y.Map && elemMap.size > 0) {
          const keys: string[] = [];
          elemMap.forEach((_: unknown, key: string) => { keys.push(key); });
          for (const k of keys) elemMap.delete(k);
        }
      });
    });
  }

  protected buildPersistPayload(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): PersistPayload | null {
    const pagesMap = ydoc.getMap(YDOC_PAGES);

    const lastSnapshot = this.snapshotCache.get(documentName) as SlideSnapshot | undefined;

    // Step3: 优先从 pageOrderMap（Y.Map）读取，fallback 到 pageOrder（Y.Array）
    const pageOrderMapY = ydoc.getMap(YDOC_PAGE_ORDER_MAP);
    let currentPageOrder: string[];
    if (pageOrderMapY.size > 0) {
      currentPageOrder = getOrderedIds(pageOrderMapY);
    } else {
      const pageOrderArr = ydoc.getArray<string>(YDOC_PAGE_ORDER);
      const rawCurrentPageOrder: string[] = [];
      for (let i = 0; i < pageOrderArr.length; i++) rawCurrentPageOrder.push(pageOrderArr.get(i));
      currentPageOrder = deduplicateStrings(rawCurrentPageOrder);
    }

    const changedPages: Record<string, Record<string, unknown>> = {};
    const newPages: Record<string, Record<string, unknown>> = {};
    const deletedPageIds: string[] = [];

    // SLD-003: 页面级 digest 缓存 — 先计算哈希，仅对变化页面执行 yPageToJson
    const currentDigests = new Map<string, PageDigest>();

    if (lastSnapshot) {
      const visitedPageIds = new Set<string>();

      pagesMap.forEach((value, pageId) => {
        if (!(value instanceof Y.Map)) return;
        visitedPageIds.add(pageId);

        const currentHash = hashPageContent(value);
        currentDigests.set(pageId, { contentHash: currentHash });

        const lastDigest = lastSnapshot.pageDigests.get(pageId);
        if (!lastDigest) {
          newPages[pageId] = { ...yPageToJson(value), order: currentPageOrder.indexOf(pageId) };
        } else if (currentHash !== lastDigest.contentHash) {
          changedPages[pageId] = yPageToJson(value);
        }
      });

      for (const pageId of lastSnapshot.pageDigests.keys()) {
        if (!visitedPageIds.has(pageId)) deletedPageIds.push(pageId);
      }
    } else {
      // CL-003: LRU 淘汰后无快照基准，走全量持久化路径。
      // 所有页面发为 changed_pages（而非 new_pages），语义更准确：
      // 这些页面大概率已存在于 Django，Django 端 changed_pages 处理器
      // 对不存在的页面会 fallback 到 update_or_create（UPSERT），确保幂等。
      console.warn(`[SlideDB] No snapshot for ${documentName} (LRU eviction?), full-sync all pages`);
      pagesMap.forEach((value, pageId) => {
        if (!(value instanceof Y.Map)) return;
        changedPages[pageId] = yPageToJson(value);
        currentDigests.set(pageId, { contentHash: hashPageContent(value) });
      });
    }

    const totalOps = Object.keys(changedPages).length + Object.keys(newPages).length + deletedPageIds.length;
    const pageOrderChanged = lastSnapshot && JSON.stringify(currentPageOrder) !== JSON.stringify(lastSnapshot.pageOrder);

    // meta: theme / project_name / font_meta
    const metaMap = ydoc.getMap(YDOC_META);
    const currentTheme = metaMap.get("theme");
    const currentName = metaMap.get("project_name");
    const currentFontMeta = metaMap.get("font_meta");
    let metaPayload: { theme?: unknown; name?: string; font_meta?: unknown } | undefined;
    const lastMeta = lastSnapshot?.meta;
    const themeChanged = currentTheme !== undefined && JSON.stringify(currentTheme) !== JSON.stringify(lastMeta?.theme);
    const nameChanged = typeof currentName === "string" && currentName !== lastMeta?.name;
    const fontMetaChanged = currentFontMeta !== undefined && JSON.stringify(currentFontMeta) !== JSON.stringify(lastMeta?.font_meta);
    if (themeChanged || nameChanged || fontMetaChanged) {
      metaPayload = {};
      if (themeChanged) metaPayload.theme = currentTheme;
      if (nameChanged) metaPayload.name = currentName as string;
      if (fontMetaChanged) metaPayload.font_meta = currentFontMeta;
    }

    if (totalOps === 0 && !pageOrderChanged && !metaPayload) return null;

    // SLD-003: 暂存 digest 供 onStoreSuccess 复用，避免二次哈希计算
    const currentMeta: { theme?: unknown; name?: string; font_meta?: unknown } = {};
    if (currentTheme !== undefined) currentMeta.theme = currentTheme;
    if (typeof currentName === "string") currentMeta.name = currentName;
    if (currentFontMeta !== undefined) currentMeta.font_meta = currentFontMeta;
    this._pendingSnapshots.set(documentName, {
      pageDigests: currentDigests,
      pageOrder: currentPageOrder,
      meta: currentMeta,
    });

    const opId = `slide_collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { editorType, editorId, editorName } = extractEditorInfo(context);
    const version = (metaMap.get("version") as number) ?? 0;

    return {
      changes: {
        changed_pages: changedPages,
        new_pages: newPages,
        deleted_page_ids: deletedPageIds,
        page_order: currentPageOrder,
        meta: metaPayload,
        base_version: version,
        op_id: opId,
        editor_type: editorType,
        editor_id: editorId,
      },
      op_id: opId,
      editor_type: editorType,
      editor_id: editorId,
      editor_name: editorName,
    };
  }

  protected onStoreSuccess(ydoc: Y.Doc, documentName: string, result: unknown): void {
    const newVersion = (result as Record<string, unknown>)?.version as number | undefined;
    if (newVersion != null) {
      ydoc.getMap(YDOC_META).set("version", newVersion);
    }
    // SLD-003: 复用 buildPersistPayload 已计算的 digest，避免二次哈希。
    // pending snapshot 精确反映已持久化时的 Y.Doc 状态，作为 diff 基准更准确。
    const pending = this._pendingSnapshots.get(documentName);
    if (pending) {
      this._pendingSnapshots.delete(documentName);
      this.snapshotCache.set(documentName, pending);
    } else {
      this.saveSnapshot(documentName, ydoc);
    }
  }

  protected onStoreConflict(ydoc: Y.Doc, documentName: string, conflictResult: Record<string, unknown>): void {
    const serverVersion = (conflictResult.current_version ?? conflictResult.current_revn) as number | undefined;
    if (serverVersion != null) {
      ydoc.getMap(YDOC_META).set("version", serverVersion);
    }
    // CR-020: 不再 saveSnapshot——conflict 时的快照可能与 Django 端不一致，
    // 基类会在 buildPersistPayload 后清空 snapshotCache。
    // 保留旧 snapshotCache 让 retry 的 diff 包含实际变更而非空集。
    // SLD-003: 清理过期的 pending digest 缓存
    this._pendingSnapshots.delete(documentName);
  }

  protected clearSnapshot(documentName: string): void {
    this._pendingSnapshots.delete(documentName);
  }

  /** 清理指定文档的所有缓存（snapshotCache + _pendingSnapshots） */
  clearAllCaches(documentName: string): void {
    this.snapshotCache.delete(documentName);
    this._pendingSnapshots.delete(documentName);
  }

  protected logStoreSuccess(resourceId: string, result: unknown, latencyMs: number): void {
    const r = result as Record<string, unknown> | undefined;
    console.log(
      `[SlideDB] Persisted changes for slide ${resourceId}: ` +
      `changed=${r?.persisted ?? 0} created=${r?.created ?? 0} deleted=${r?.deleted ?? 0} ` +
      `version=${r?.version} (${latencyMs}ms)`,
    );
  }

}

export function clearSlideSnapshot(documentName: string): void {
  singletonInstance?.clearAllCaches(documentName);
}
