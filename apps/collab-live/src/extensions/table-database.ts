/**
 * Table Database Extension
 *
 * TabData 的 Hocuspocus 持久化扩展，继承 BaseCollabDatabase。
 *
 * Y.Doc 数据模型:
 *   records:     Y.Map<recordId, Y.Map<fieldId_hex, cellValue>> — 稀疏 __position_id 真相
 *   rowOrderMap: Y.Map<recordId, position>                   — legacy 行序投影（LWW）
 *   rowOrder:    Y.Array<recordId>                           — [DEPRECATED] 仅用于旧客户端 fallback 读取
 *   meta:        Y.Map  (fields, version, table_name)
 */

import * as Y from "yjs";
import { deepEqual } from "../lib/deep-equal.js";
import {
  BaseCollabDatabase,
  isIncompleteAuthoritativeRecordSnapshot,
  type PersistPayload,
} from "./base-collab-database.js";
import { extractEditorInfo } from "../lib/collab-utils.js";
import { withRetry } from "../lib/retry.js";
import { fetchCollabSnapshot } from "../services/django-api.js";
import { getOrderedIds, setOrderedIds } from "../lib/y-utils.js";
import { YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_META, YDOC_VIEWS, YDOC_VIEW_ORDER_MAP } from "@tabtin/table-engine/collab/ydoc-schema";
import {
  applyTableRecordOrderPlan,
  getEffectiveTableRecordOrder,
  LEGACY_RECORD_ORDER_FIELD,
  planTableRecordOrderReconcile,
} from "@tabtin/table-engine/collab/table-record-order";

const YDOC_ROW_ORDER_MAP = "rowOrderMap";
const POSITION_ID_KEY = "__position_id";
const LEGACY_ROW_ORDER_POSITION_INVALIDATION_ORIGIN = {
  type: "legacy-row-order-position-id-invalidation",
};
const BLANK_RECORD_ID_CLEANUP_ORIGIN = {
  type: "blank-record-id-cleanup",
};

interface RecordDigest {
  contentHash: string;
  fieldKeys: string[];
}

interface RecordOrderBaseline {
  rowOrderMapScalar: unknown;
  legacyOrder: unknown;
  hasPositionId: boolean;
  positionId: unknown;
}

interface TableSnapshot {
  recordDigests: Map<string, RecordDigest>;
  recordOrderBaselines: Map<string, RecordOrderBaseline>;
  rowOrder: string[];
  fields: unknown[] | undefined;
  views: Record<string, unknown>;
}

interface PendingTableStore {
  snapshot: TableSnapshot;
  sentCells: Map<string, Map<string, unknown>>;
  outboundRecords: Map<string, Map<string, unknown>>;
  sentFields?: unknown[];
  sentViews?: Record<string, unknown>;
  sentRecordEditorRevisions: Map<string, number>;
  sentRecordMutationRevisions: Map<string, number>;
  sentRecordLifecycleRevalidationIds: Set<string>;
}

interface RecordEditorProvenance {
  editorId: string;
  revision: number;
}

export class MissingTableSnapshotBaselineError extends Error {
  constructor(documentName: string) {
    super(`Missing snapshot baseline for ${documentName}; resync required before persist`);
    this.name = "MissingTableSnapshotBaselineError";
  }
}

function uniqueIds(ids: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  return result;
}

function isBlankRecordId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length === 0;
}

function removeBlankRecordIdProjectionEntries(
  ydoc: Y.Doc,
  documentName: string,
): string[] {
  const recordsMap = ydoc.getMap(YDOC_RECORDS);
  const rowOrderMap = ydoc.getMap<unknown>(YDOC_ROW_ORDER_MAP);
  const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER);
  const blankRecordIds = new Set<string>();

  recordsMap.forEach((_value, recordId) => {
    if (isBlankRecordId(recordId)) blankRecordIds.add(recordId);
  });
  rowOrderMap.forEach((_value, recordId) => {
    if (isBlankRecordId(recordId)) blankRecordIds.add(recordId);
  });
  for (const recordId of rowOrder.toArray()) {
    if (isBlankRecordId(recordId)) blankRecordIds.add(recordId);
  }

  if (blankRecordIds.size === 0) return [];

  ydoc.transact(() => {
    for (const recordId of blankRecordIds) {
      recordsMap.delete(recordId);
      rowOrderMap.delete(recordId);
    }
    for (let index = rowOrder.length - 1; index >= 0; index -= 1) {
      if (isBlankRecordId(rowOrder.get(index))) rowOrder.delete(index, 1);
    }
  }, BLANK_RECORD_ID_CLEANUP_ORIGIN);

  console.warn(
    `[TableDB] Removed ${blankRecordIds.size} blank record-id projection(s) from ${documentName}`,
  );
  return Array.from(blankRecordIds);
}

function resolveLegacyRowOrder(ydoc: Y.Doc, lastSnapshot?: TableSnapshot): string[] {
  const rowOrderMapRef = ydoc.getMap<number>(YDOC_ROW_ORDER_MAP);
  const rowOrderArr = ydoc.getArray<string>(YDOC_ROW_ORDER);
  const arrayOrder: string[] = [];
  for (let i = 0; i < rowOrderArr.length; i++) {
    arrayOrder.push(rowOrderArr.get(i));
  }

  if (rowOrderMapRef.size > 0) {
    const mapOrder = getOrderedIds(rowOrderMapRef);
    const uniqueArrayOrder = uniqueIds(arrayOrder);
    const arrayIds = new Set(uniqueArrayOrder);
    const arrayContainsAllMapIds = mapOrder.every((recordId) => arrayIds.has(recordId));
    const mapStillMatchesSnapshot =
      lastSnapshot != null &&
      mapOrder.length === lastSnapshot.rowOrder.length &&
      mapOrder.every((recordId, index) => recordId === lastSnapshot.rowOrder[index]);
    const arrayMatchesSnapshot =
      lastSnapshot != null &&
      uniqueArrayOrder.length === lastSnapshot.rowOrder.length &&
      uniqueArrayOrder.every((recordId, index) => recordId === lastSnapshot.rowOrder[index]);
    const snapshotMapProjection = lastSnapshot?.rowOrder.filter((recordId) => rowOrderMapRef.has(recordId)) ?? [];
    const mapMatchesSnapshotProjection =
      snapshotMapProjection.length === mapOrder.length &&
      mapOrder.every((recordId, index) => recordId === snapshotMapProjection[index]);

    if (
      arrayContainsAllMapIds &&
      (mapStillMatchesSnapshot || (arrayMatchesSnapshot && mapMatchesSnapshotProjection))
    ) {
      return uniqueArrayOrder;
    }

    const seen = new Set(mapOrder);
    for (const recordId of uniqueArrayOrder) {
      if (!seen.has(recordId)) {
        mapOrder.push(recordId);
        seen.add(recordId);
      }
    }
    return mapOrder;
  }

  return uniqueIds(arrayOrder);
}

function resolveLegacyArrayOverride(
  ydoc: Y.Doc,
  lastSnapshot?: TableSnapshot,
): string[] | null {
  if (!lastSnapshot) return null;
  const mapOrder = getOrderedIds(ydoc.getMap<number>(YDOC_ROW_ORDER_MAP));
  const arrayOrder = uniqueIds(ydoc.getArray<string>(YDOC_ROW_ORDER).toArray());
  const mapMatchesBaseline = (
    mapOrder.length === lastSnapshot.rowOrder.length
    && mapOrder.every((recordId, index) => recordId === lastSnapshot.rowOrder[index])
  );
  const arrayContainsMap = mapOrder.every(recordId => arrayOrder.includes(recordId));
  const arrayChanged = (
    arrayOrder.length !== lastSnapshot.rowOrder.length
    || arrayOrder.some((recordId, index) => recordId !== lastSnapshot.rowOrder[index])
  );
  return mapMatchesBaseline && arrayContainsMap && arrayChanged ? arrayOrder : null;
}

function legacyOrderScalar(value: unknown): string | number | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return undefined;
}

function compareLegacyOrderScalars(
  left: string | number,
  right: string | number,
): number {
  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return typeof left === "number" ? -1 : 1;
}

/** Resolve an old record.__order mutation without dropping map-only/orphan ids. */
function resolveLegacyRecordOrderIntent(
  ydoc: Y.Doc,
  lastSnapshot: TableSnapshot,
  changedRecordIds: ReadonlySet<string>,
): string[] {
  const recordsMap = ydoc.getMap(YDOC_RECORDS);
  const fallbackOrder = resolveLegacyRowOrder(ydoc, lastSnapshot);
  const orderedIds = [...fallbackOrder];
  const knownIds = new Set(orderedIds);
  recordsMap.forEach((_value, recordId) => {
    if (!knownIds.has(recordId)) {
      orderedIds.push(recordId);
      knownIds.add(recordId);
    }
  });

  const fallbackIndex = new Map(
    orderedIds.map((recordId, index) => [recordId, index]),
  );
  return orderedIds.slice().sort((leftId, rightId) => {
    const leftRecord = recordsMap.get(leftId);
    const rightRecord = recordsMap.get(rightId);
    const leftOrder = leftRecord instanceof Y.Map
      ? legacyOrderScalar(leftRecord.get(LEGACY_RECORD_ORDER_FIELD))
      : undefined;
    const rightOrder = rightRecord instanceof Y.Map
      ? legacyOrderScalar(rightRecord.get(LEGACY_RECORD_ORDER_FIELD))
      : undefined;

    if (leftOrder !== undefined && rightOrder !== undefined) {
      const compared = compareLegacyOrderScalars(leftOrder, rightOrder);
      if (compared !== 0) return compared;
    } else if (leftOrder === undefined && rightOrder !== undefined) {
      if (changedRecordIds.has(leftId)) return 1;
    } else if (leftOrder !== undefined && rightOrder === undefined) {
      if (changedRecordIds.has(rightId)) return -1;
    }

    return (fallbackIndex.get(leftId) ?? Number.MAX_SAFE_INTEGER)
      - (fallbackIndex.get(rightId) ?? Number.MAX_SAFE_INTEGER)
      || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0);
  });
}

/**
 * TBD-006: 对 Y.Map record 内容计算双哈希指纹（FNV-1a + djb2），
 * 提供 64-bit 碰撞抗性，避免在快照缓存中存储完整字段值导致大表内存膨胀。
 */
function hashRecordValues(
  keys: string[],
  getValue: (key: string) => unknown,
): string {
  let h1 = 2166136261;
  let h2 = 5381;
  for (const key of keys) {
    const value = getValue(key);
    const str = key + "\0" + (
      value === null ? "\x01null" :
      value === undefined ? "\x01undef" :
      typeof value === "string" ? value :
      JSON.stringify(value)
    );
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619);
      h2 = ((h2 << 5) + h2 + c) | 0;
    }
    h1 = Math.imul(h1 ^ 0x1f, 16777619);
    h2 = ((h2 << 5) + h2 + 0x1f) | 0;
  }
  return `${h1 >>> 0}:${h2 >>> 0}`;
}

function hashRecordContent(record: Y.Map<unknown>): string {
  const keys: string[] = [];
  record.forEach((_, k) => keys.push(k));
  keys.sort();
  return hashRecordValues(keys, key => record.get(key));
}

function digestRecordCells(cells: Map<string, unknown>): RecordDigest {
  const fieldKeys = Array.from(cells.keys()).sort();
  return {
    contentHash: hashRecordValues(fieldKeys, key => cells.get(key)),
    fieldKeys,
  };
}

function recordMatchesOutboundCells(
  record: Y.Map<unknown>,
  outboundCells: Map<string, unknown>,
): boolean {
  if (record.size !== outboundCells.size) return false;
  for (const [fieldHex, sentValue] of outboundCells) {
    if (!record.has(fieldHex) || !deepEqual(record.get(fieldHex), sentValue)) {
      return false;
    }
  }
  return true;
}

/** 从视图对象中读取 config_rev（缺失/非法按 0 处理）。 */
export function viewConfigRev(view: unknown): number {
  if (view && typeof view === "object") {
    const rev = (view as Record<string, unknown>).config_rev;
    if (typeof rev === "number" && Number.isFinite(rev)) return rev;
  }
  return 0;
}

/**
 * 计算合并后需要恢复为「客户端未持久化版本」的视图集合（视图配置回退防护）。
 *
 * 仅当客户端 preFetch 视图的 config_rev 严格高于 Django 快照、且高于合并结果时才恢复。
 * 这样既能挡住旧快照把新配置覆盖回退，又不会回退其它客户端更高版本的并发写入。
 *
 * @param preFetch    viewId → 客户端 preFetch 视图对象（含 config_rev）
 * @param snapshotRev viewId → Django 快照视图的 config_rev
 * @param mergedRev   viewId → CRDT 合并结果视图的 config_rev
 */
export function selectViewsToRestoreByConfigRev(
  preFetch: Map<string, unknown>,
  snapshotRev: Map<string, number>,
  mergedRev: Map<string, number>,
): Array<{ id: string; view: unknown }> {
  const restores: Array<{ id: string; view: unknown }> = [];
  preFetch.forEach((preView, viewId) => {
    const preRev = viewConfigRev(preView);
    const snapRev = snapshotRev.get(viewId) ?? 0;
    const merged = mergedRev.get(viewId) ?? 0;
    if (preRev > snapRev && preRev > merged) {
      restores.push({ id: viewId, view: preView });
    }
  });
  return restores;
}

let singletonInstance: TableDatabase | null = null;

export class TableDatabase extends BaseCollabDatabase {
  private readonly recordEditorsByDocument = new Map<
    string,
    Map<string, RecordEditorProvenance>
  >();
  private readonly recordMutationRevisionsByDocument = new Map<
    string,
    Map<string, number>
  >();
  /**
   * One-shot lifecycle candidates requested by the test-only repair command.
   * They remain queued across failed stores and are cleared only after a
   * successful Django lifecycle classification.
   */
  private readonly recordLifecycleRevalidationsByDocument = new Map<
    string,
    Set<string>
  >();
  private readonly observedRecordDocs = new WeakSet<Y.Doc>();
  private readonly observedLegacyRecordOrderDocs = new WeakSet<Y.Doc>();
  private readonly pendingLegacyRecordOrderWrites = new WeakMap<Y.Doc, Set<string>>();
  private recordMutationRevision = 0;

  private observeLegacyRecordOrderWrites(ydoc: Y.Doc): void {
    if (this.observedLegacyRecordOrderDocs.has(ydoc)) return;
    this.observedLegacyRecordOrderDocs.add(ydoc);

    const recordsMap = ydoc.getMap(YDOC_RECORDS);
    recordsMap.observeDeep((events, transaction) => {
      if (transaction.origin === LEGACY_ROW_ORDER_POSITION_INVALIDATION_ORIGIN) return;

      const legacyOrderChanges = new Set<string>();
      const positionIdChanges = new Set<string>();
      for (const event of events) {
        const [recordId] = event.path;
        if (typeof recordId !== "string" || event.target === recordsMap) continue;
        const keysChanged = (event as Y.YMapEvent<unknown>).keysChanged;
        if (keysChanged.has(LEGACY_RECORD_ORDER_FIELD)) legacyOrderChanges.add(recordId);
        if (keysChanged.has(POSITION_ID_KEY)) positionIdChanges.add(recordId);
      }
      if (legacyOrderChanges.size === 0) return;

      let pending = this.pendingLegacyRecordOrderWrites.get(ydoc);
      if (!pending) {
        pending = new Set<string>();
        this.pendingLegacyRecordOrderWrites.set(ydoc, pending);
      }
      for (const recordId of legacyOrderChanges) {
        if (positionIdChanges.has(recordId)) pending.delete(recordId);
        else pending.add(recordId);
      }
      if (pending.size === 0) this.pendingLegacyRecordOrderWrites.delete(ydoc);
    });
  }

  /**
   * Database.store 是 document 级 debounce，一次 payload 可能混合多个连接的编辑。
   * 在 Y.Doc transaction 发生时按 record 记录认证连接，不能在 store 阶段用房间首连接猜作者。
   */
  private observeRecordEditorProvenance(documentName: string, ydoc: Y.Doc): void {
    if (this.observedRecordDocs.has(ydoc)) return;
    this.observedRecordDocs.add(ydoc);

    const recordsMap = ydoc.getMap(YDOC_RECORDS);
    recordsMap.observeDeep((events, transaction) => {
      const affectedRecordIds = new Set<string>();
      for (const event of events) {
        if (event.target === recordsMap) {
          (event as Y.YMapEvent<unknown>).keysChanged.forEach((recordId) => {
            affectedRecordIds.add(recordId);
          });
          continue;
        }
        const [recordId] = event.path;
        if (typeof recordId === "string") affectedRecordIds.add(recordId);
      }
      if (affectedRecordIds.size === 0) return;

      const revision = ++this.recordMutationRevision;
      let recordMutationRevisions = this.recordMutationRevisionsByDocument.get(documentName);
      if (!recordMutationRevisions) {
        recordMutationRevisions = new Map();
        this.recordMutationRevisionsByDocument.set(documentName, recordMutationRevisions);
      }
      for (const recordId of affectedRecordIds) {
        recordMutationRevisions.set(recordId, revision);
      }

      const origin = transaction.origin as
        | { context?: Record<string, unknown> }
        | null
        | undefined;
      const { editorId } = extractEditorInfo(origin?.context);
      if (!editorId) return;

      let recordEditors = this.recordEditorsByDocument.get(documentName);
      if (!recordEditors) {
        recordEditors = new Map();
        this.recordEditorsByDocument.set(documentName, recordEditors);
      }
      for (const recordId of affectedRecordIds) {
        recordEditors.set(recordId, { editorId, revision });
      }
    });
  }

  private removeBlankRecordIdProjections(documentName: string, ydoc: Y.Doc): void {
    const removedRecordIds = removeBlankRecordIdProjectionEntries(ydoc, documentName);
    if (removedRecordIds.length === 0) return;

    const recordEditors = this.recordEditorsByDocument.get(documentName);
    const recordMutationRevisions = this.recordMutationRevisionsByDocument.get(documentName);
    const lifecycleRevalidations = this.recordLifecycleRevalidationsByDocument.get(documentName);
    const pendingLegacyRecordOrderWrites = this.pendingLegacyRecordOrderWrites.get(ydoc);
    for (const recordId of removedRecordIds) {
      recordEditors?.delete(recordId);
      recordMutationRevisions?.delete(recordId);
      lifecycleRevalidations?.delete(recordId);
      pendingLegacyRecordOrderWrites?.delete(recordId);
    }
    if (recordEditors?.size === 0) this.recordEditorsByDocument.delete(documentName);
    if (recordMutationRevisions?.size === 0) {
      this.recordMutationRevisionsByDocument.delete(documentName);
    }
    if (lifecycleRevalidations?.size === 0) {
      this.recordLifecycleRevalidationsByDocument.delete(documentName);
    }
    if (pendingLegacyRecordOrderWrites?.size === 0) {
      this.pendingLegacyRecordOrderWrites.delete(ydoc);
    }
  }

  async afterLoadDocument(data: { documentName: string; document: Y.Doc }): Promise<void> {
    this.removeBlankRecordIdProjections(data.documentName, data.document);
    this.observeRecordEditorProvenance(data.documentName, data.document);
    this.observeLegacyRecordOrderWrites(data.document);
  }
  /** 每个在途请求实际发出时的状态；ACK 只能确认到这里。 */
  private readonly pendingStores = new Map<string, PendingTableStore>();

  constructor() {
    super();
    if (singletonInstance) console.warn("[TableDB] Singleton already exists, overwriting");
    singletonInstance = this;
  }

  protected getPrefix(): string { return "table:"; }
  protected getResourceType(): string { return "table"; }
  protected getModuleLabel(): string { return "TableDB"; }

  public queueRecordLifecycleRevalidation(
    documentName: string,
    recordIds: string[],
  ): number {
    let queued = this.recordLifecycleRevalidationsByDocument.get(documentName);
    if (!queued) {
      queued = new Set<string>();
      this.recordLifecycleRevalidationsByDocument.set(documentName, queued);
    }
    let added = 0;
    for (const recordId of recordIds) {
      if (!recordId || queued.has(recordId)) continue;
      queued.add(recordId);
      added += 1;
    }
    if (queued.size === 0) {
      this.recordLifecycleRevalidationsByDocument.delete(documentName);
    }
    return added;
  }

  /** 保存 Y.Doc 当前状态为 diff 快照（供 Agent push 后调用） */
  saveSnapshot(documentName: string, ydoc: Y.Doc): void {
    this.removeBlankRecordIdProjections(documentName, ydoc);
    this.observeLegacyRecordOrderWrites(ydoc);
    const lastSnapshot = this.snapshotCache.get(documentName) as TableSnapshot | undefined;
    this.snapshotCache.set(
      documentName,
      this.captureSnapshot(documentName, ydoc, lastSnapshot),
    );
    this.pendingLegacyRecordOrderWrites.delete(ydoc);
  }

  private captureSnapshot(
    documentName: string,
    ydoc: Y.Doc,
    lastSnapshot?: TableSnapshot,
  ): TableSnapshot {
    const recordsMap = ydoc.getMap(YDOC_RECORDS);
    const rowOrderMap = ydoc.getMap<unknown>(YDOC_ROW_ORDER_MAP);

    const recordDigests = new Map<string, RecordDigest>();
    const recordOrderBaselines = new Map<string, RecordOrderBaseline>();
    recordsMap.forEach((value, recordId) => {
      if (value instanceof Y.Map) {
        const fieldKeys: string[] = [];
        value.forEach((_, k) => fieldKeys.push(k));
        fieldKeys.sort();
        recordDigests.set(recordId, {
          contentHash: hashRecordContent(value),
          fieldKeys,
        });
        recordOrderBaselines.set(recordId, {
          rowOrderMapScalar: rowOrderMap.get(recordId),
          legacyOrder: value.get(LEGACY_RECORD_ORDER_FIELD),
          hasPositionId: value.has(POSITION_ID_KEY),
          positionId: value.get(POSITION_ID_KEY),
        });
      } else {
        console.warn(`[TableDB] saveSnapshot: record "${recordId}" in "${documentName}" is not a Y.Map (type: ${typeof value}), skipping`);
      }
    });

    const legacyArrayOverride = resolveLegacyArrayOverride(ydoc, lastSnapshot);
    const hasExplicitPositionIds = Array.from(recordsMap.values()).some(
      value => value instanceof Y.Map && value.has(POSITION_ID_KEY),
    );
    const rowOrder = hasExplicitPositionIds
      ? getEffectiveTableRecordOrder(ydoc)
      : (legacyArrayOverride ?? resolveLegacyRowOrder(ydoc, lastSnapshot));

    const meta = ydoc.getMap(YDOC_META);
    const fields = meta.get("fields") as unknown[] | undefined;
    const viewsMap = ydoc.getMap<unknown>(YDOC_VIEWS);
    const views: Record<string, unknown> = {};
    viewsMap.forEach((value, viewId) => {
      views[viewId] = value;
    });

    return {
      recordDigests,
      recordOrderBaselines,
      rowOrder,
      fields,
      views,
    } satisfies TableSnapshot;
  }

  protected applySnapshotToDoc(initDoc: Y.Doc, snapshot: Record<string, unknown>): void {
    const recordsMap = initDoc.getMap(YDOC_RECORDS);
    for (const [recordId, fieldValues] of Object.entries(snapshot.records as Record<string, unknown>)) {
      const recordYMap = new Y.Map<unknown>();
      for (const [fieldHex, value] of Object.entries(fieldValues as Record<string, unknown>)) {
        recordYMap.set(fieldHex, value);
      }
      recordsMap.set(recordId, recordYMap);
    }

    // step4: 只写 Y.Map，移除 Y.Array 双写
    // 旧客户端只写 Y.Array 时，saveSnapshot/buildPersistPayload 的 fallback 路径仍可读取（向后兼容）
    const snapshotRowOrder = snapshot.row_order as string[];
    const rowOrderMap = initDoc.getMap<string>(YDOC_ROW_ORDER_MAP);
    setOrderedIds(rowOrderMap, snapshotRowOrder);

    const views = Array.isArray(snapshot.views) ? snapshot.views as Array<Record<string, unknown>> : [];
    const viewsMap = initDoc.getMap<unknown>(YDOC_VIEWS);
    const viewOrderMap = initDoc.getMap<number>(YDOC_VIEW_ORDER_MAP);
    for (const view of views) {
      const viewId = typeof view.id === "string" ? view.id : "";
      if (!viewId) continue;
      viewsMap.set(viewId, view);
      const order = typeof view.order === "number" ? view.order : viewOrderMap.size;
      viewOrderMap.set(viewId, order);
    }

    const meta = initDoc.getMap(YDOC_META);
    meta.set("fields", snapshot.fields);
    meta.set("version", snapshot.table_version);
    meta.set("table_name", snapshot.table_name);
    meta.set("table_id", snapshot.table_id);
    if (snapshot.schema_version != null) {
      meta.set("schema_version", snapshot.schema_version);
    }
    // Write both states: a previously truncated live document must become
    // tail-mutable again after a later complete snapshot is fetched.
    meta.set("is_truncated", snapshot.is_truncated === true);
    meta.set("total_records", (snapshot.total_records as number) || recordsMap.size);
  }

  protected onSnapshotLoaded(documentName: string, initDoc: Y.Doc): void {
    this.saveSnapshot(documentName, initDoc);
  }

  protected prepareYDocForMerge(ydoc: Y.Doc, _snapshot?: Record<string, unknown>): void {
    // TBD-002 / step4: 清空 rowOrder Y.Array，使 _reconcileConcurrentArrayItems 只恢复
    // preFetchState 中真正的并发新增条目（而非 Django 快照数据）。
    // step4 后 applySnapshotToDoc 不再写 Y.Array，initDoc 中 Y.Array 为空，
    // mergeDoc 合并后 Y.Array 只剩 preFetchState 中的旧数据 → 清空后由 reconcile 恢复并发条目。
    // Y.Map（rowOrderMap）不需要预清空：LWW 语义，initDoc 的 set 自然合并，不翻倍。
    const existingRowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER);
    if (existingRowOrder.length > 0) {
      ydoc.transact(() => {
        existingRowOrder.delete(0, existingRowOrder.length);
      });
    }
  }

  /**
   * TBD-002: merge 后清理 records Y.Map 中的孤立条目。
   *
   * 由于 prepareYDocForMerge 不再清空 records，preFetchState 中 DB 已删除的行
   * 仍会留在 mergeDoc 的 records Y.Map 中。在 merge 完成后（rowOrder 已包含
   * DB 数据 + reconciliation 恢复的并发条目），清理不在 DB 且不在 rowOrder 中
   * 的孤立 record 条目，避免 Y.Doc binary 膨胀和 buildPersistPayload 污染。
   */
  protected reconcileConcurrentItems(
    mergeDoc: Y.Doc,
    preFetchDoc: Y.Doc,
    snapshot: Record<string, unknown>,
  ): void {
    this.reconcileConcurrentViews(mergeDoc, preFetchDoc, snapshot);

    const records = mergeDoc.getMap(YDOC_RECORDS);
    const rowOrder = mergeDoc.getArray<string>(YDOC_ROW_ORDER);
    const rowOrderMap = mergeDoc.getMap<number>(YDOC_ROW_ORDER_MAP);
    const snapshotRecords = (snapshot.records ?? {}) as Record<string, unknown>;

    // step4: 以 snapshot.row_order 为 Django 权威顺序（而非当前 rowOrderMap，
    // 因为 rowOrderMap 可能包含旧的孤立条目）。
    // rowOrder Y.Array 在 prepareYDocForMerge 清空后，由 _reconcileConcurrentArrayItems
    // 从 preFetchState 恢复了并发新增条目（不在 Django 快照中的行）。
    // 将两者合并：Django 顺序（snapshot）+ 并发新增（Y.Array 中不在 snapshot 的条目）。
    const snapshotRowOrder = (snapshot.row_order as string[] | undefined) ?? [];
    const djangoIds = snapshotRowOrder;
    const djangoIdSet = new Set<string>(djangoIds);

    const concurrentIds: string[] = [];
    for (let i = 0; i < rowOrder.length; i++) {
      const id = rowOrder.get(i);
      if (!djangoIdSet.has(id)) {
        concurrentIds.push(id);
      }
    }

    const reconciledIds = [...djangoIds, ...concurrentIds];
    const rowOrderSet = new Set<string>(reconciledIds);

    const staleKeys: string[] = [];
    records.forEach((_, key) => {
      if (!(key in snapshotRecords) && !rowOrderSet.has(key)) {
        staleKeys.push(key);
      }
    });

    if (staleKeys.length > 0) {
      mergeDoc.transact(() => {
        for (const key of staleKeys) {
          records.delete(key);
        }
      });
      const tableId = snapshot.table_id ?? "unknown";
      console.log(
        `[TableDB] Cleaned up ${staleKeys.length} orphaned record(s) not in DB snapshot or rowOrder (table=${tableId})`,
      );
    }

    mergeDoc.transact(() => {
      for (const [recordId, fieldValues] of Object.entries(snapshotRecords)) {
        let recordMap = records.get(recordId) as Y.Map<unknown> | undefined;
        if (!(recordMap instanceof Y.Map)) {
          recordMap = new Y.Map<unknown>();
          records.set(recordId, recordMap);
        }
        const targetRecord = recordMap;

        const snapshotFieldValues = fieldValues as Record<string, unknown>;
        const snapshotFieldKeys = new Set(Object.keys(snapshotFieldValues));
        const fieldsToDelete: string[] = [];
        targetRecord.forEach((_value: unknown, fieldKey: string) => {
          if (!snapshotFieldKeys.has(fieldKey)) {
            fieldsToDelete.push(fieldKey);
          }
        });

        fieldsToDelete.forEach((fieldKey) => targetRecord.delete(fieldKey));
        for (const [fieldKey, fieldValue] of Object.entries(snapshotFieldValues)) {
          targetRecord.set(fieldKey, fieldValue);
        }
      }
    });

    setOrderedIds(rowOrderMap, reconciledIds);
    const meta = mergeDoc.getMap(YDOC_META);
    meta.set("is_truncated", snapshot.is_truncated === true);
    meta.set("total_records", (snapshot.total_records as number) || reconciledIds.length);
  }

  /**
   * Snapshot fetch is optimistic: edits can land on the live Y.Doc while the
   * Django request is in flight. Reapply only fields/scalars that differ from
   * the captured pre-fetch state, after snapshot reconciliation, so an older
   * snapshot cannot roll back a record move or cell edit.
   */
  protected reconcileConcurrentEdits(
    mergeDoc: Y.Doc,
    preFetchDoc: Y.Doc,
    liveDoc: Y.Doc,
  ): void {
    const preFetchRecords = preFetchDoc.getMap<unknown>(YDOC_RECORDS);
    const liveRecords = liveDoc.getMap<unknown>(YDOC_RECORDS);
    const mergedRecords = mergeDoc.getMap<unknown>(YDOC_RECORDS);

    // Comparing only the values at fetch start/end misses ABA edits
    // (A -> C -> A). Replaying the update since the captured state vector on a
    // probe document lets Yjs tell us which record fields/map keys were
    // actually touched, even when their final value equals the baseline.
    const touchedRecordEntries = new Set<string>();
    const touchedRecordFields = new Map<string, Set<string>>();
    const touchedRowOrderKeys = new Set<string>();
    const probeDoc = new Y.Doc();
    Y.applyUpdate(probeDoc, Y.encodeStateAsUpdate(preFetchDoc));
    const probeRecords = probeDoc.getMap<unknown>(YDOC_RECORDS);
    const probeRowOrderMap = probeDoc.getMap<unknown>(YDOC_ROW_ORDER_MAP);
    const observeRecordTouches = (events: Y.YEvent<any>[]): void => {
      for (const event of events) {
        if (!(event instanceof Y.YMapEvent)) continue;
        if (event.target === probeRecords) {
          event.keysChanged.forEach(recordId => touchedRecordEntries.add(recordId));
          continue;
        }
        const recordId = event.path[0];
        if (typeof recordId !== "string") continue;
        const fields = touchedRecordFields.get(recordId) ?? new Set<string>();
        event.keysChanged.forEach(fieldId => fields.add(fieldId));
        touchedRecordFields.set(recordId, fields);
      }
    };
    const observeRowOrderTouches = (event: Y.YMapEvent<unknown>): void => {
      event.keysChanged.forEach(recordId => touchedRowOrderKeys.add(recordId));
    };
    probeRecords.observeDeep(observeRecordTouches);
    probeRowOrderMap.observe(observeRowOrderTouches);
    Y.applyUpdate(
      probeDoc,
      Y.encodeStateAsUpdate(liveDoc, Y.encodeStateVector(preFetchDoc)),
    );
    probeRecords.unobserveDeep(observeRecordTouches);
    probeRowOrderMap.unobserve(observeRowOrderTouches);
    probeDoc.destroy();

    const valuesEqual = (left: unknown, right: unknown): boolean => {
      if (Object.is(left, right)) return true;
      if (left instanceof Y.AbstractType || right instanceof Y.AbstractType) return false;
      try {
        return JSON.stringify(left) === JSON.stringify(right);
      } catch {
        return false;
      }
    };

    const copyConcurrentMapValues = (
      preFetchMap: Y.Map<unknown>,
      liveMap: Y.Map<unknown>,
      mergedMap: Y.Map<unknown>,
      forceKeys: ReadonlySet<string> = new Set(),
      forceAll = false,
    ): void => {
      const keys = new Set<string>();
      preFetchMap.forEach((_value, key) => keys.add(key));
      liveMap.forEach((_value, key) => keys.add(key));
      for (const key of keys) {
        const preFetchHas = preFetchMap.has(key);
        const liveHas = liveMap.has(key);
        if (
          !forceAll
          && !forceKeys.has(key)
          && preFetchHas === liveHas
          && (!liveHas || valuesEqual(preFetchMap.get(key), liveMap.get(key)))
        ) continue;

        if (!liveHas) {
          mergedMap.delete(key);
          continue;
        }
        const liveValue = liveMap.get(key);
        // Shared types cannot be attached to a second Y.Doc. TabData record
        // positions and cell payloads are scalar/JSON values; nested shared
        // types keep their native CRDT merge semantics.
        if (!(liveValue instanceof Y.AbstractType)) mergedMap.set(key, liveValue);
      }
    };

    mergeDoc.transact(() => {
      preFetchRecords.forEach((preFetchValue, recordId) => {
        const liveValue = liveRecords.get(recordId);
        if (!(preFetchValue instanceof Y.Map)) return;
        if (!(liveValue instanceof Y.Map)) {
          if (!liveRecords.has(recordId)) mergedRecords.delete(recordId);
          return;
        }
        const currentMergedValue = mergedRecords.get(recordId);
        const mergedValue = currentMergedValue instanceof Y.Map
          ? currentMergedValue
          : new Y.Map<unknown>();
        if (!(currentMergedValue instanceof Y.Map)) mergedRecords.set(recordId, mergedValue);
        copyConcurrentMapValues(
          preFetchValue,
          liveValue,
          mergedValue,
          touchedRecordFields.get(recordId),
          touchedRecordEntries.has(recordId),
        );
      });

      copyConcurrentMapValues(
        preFetchDoc.getMap(YDOC_ROW_ORDER_MAP),
        liveDoc.getMap(YDOC_ROW_ORDER_MAP),
        mergeDoc.getMap(YDOC_ROW_ORDER_MAP),
        touchedRowOrderKeys,
      );
    });
  }

  /**
   * 视图配置回退防护：merge 会用 Django 快照的视图（initDoc）与客户端未持久化的
   * 视图（preFetchDoc）做 CRDT 合并，Y.Map 的 LWW 由 clientID/clock 决定，可能让
   * config_rev 更低的旧快照视图覆盖客户端刚写入的新配置。
   *
   * 这里以 config_rev 单调性为准：当客户端 preFetch 视图的 config_rev 严格高于
   * Django 快照，且高于/等于合并结果时，把该视图恢复为客户端版本。
   * 常见的「首次加载」场景 preFetchDoc 为空，循环不执行，无副作用。
   */
  protected reconcileConcurrentViews(
    mergeDoc: Y.Doc,
    preFetchDoc: Y.Doc,
    snapshot: Record<string, unknown>,
  ): void {
    const preFetchViewsMap = preFetchDoc.getMap<unknown>(YDOC_VIEWS);
    if (preFetchViewsMap.size === 0) return;

    const mergedViews = mergeDoc.getMap<unknown>(YDOC_VIEWS);

    const snapshotViews = Array.isArray(snapshot.views)
      ? (snapshot.views as Array<Record<string, unknown>>)
      : [];
    const snapshotRev = new Map<string, number>(
      snapshotViews
        .filter((view) => typeof view.id === "string")
        .map((view) => [String(view.id), viewConfigRev(view)]),
    );

    const preFetch = new Map<string, unknown>();
    preFetchViewsMap.forEach((view, viewId) => preFetch.set(viewId, view));
    const mergedRev = new Map<string, number>();
    mergedViews.forEach((view, viewId) => mergedRev.set(viewId, viewConfigRev(view)));

    const restores = selectViewsToRestoreByConfigRev(preFetch, snapshotRev, mergedRev);
    if (restores.length === 0) return;

    mergeDoc.transact(() => {
      for (const { id, view } of restores) {
        mergedViews.set(id, view);
      }
    });
    const tableId = snapshot.table_id ?? "unknown";
    console.log(
      `[TableDB] Restored ${restores.length} view(s) with higher config_rev over stale snapshot (table=${tableId})`,
    );
  }

  /**
   * Lift old-client rowOrderMap / rowOrder-array / record.__order intents into
   * sparse PositionIds before persist. Planning is read-only; moved rows and
   * necessary bounds are then written with every legacy projection in one
   * origin-tagged transaction. A new client that updates PositionId together
   * with its projections is already authoritative and is left untouched.
   */
  private reconcileLegacyRecordOrderWrites(
    ydoc: Y.Doc,
    lastSnapshot: TableSnapshot,
    legacyArrayOverride: readonly string[] | null,
  ): void {
    const recordsMap = ydoc.getMap(YDOC_RECORDS);
    const rowOrderMap = ydoc.getMap<unknown>(YDOC_ROW_ORDER_MAP);
    const legacyRecordOrderIntentIds = new Set<string>();
    const legacyRowOrderMapIntentIds = new Set<string>();
    const positionIdChangedIds = new Set<string>();
    const pendingLegacyRecordOrderWrites = this.pendingLegacyRecordOrderWrites.get(ydoc);

    recordsMap.forEach((value, recordId) => {
      if (!(value instanceof Y.Map)) return;

      const baseline = lastSnapshot.recordOrderBaselines.get(recordId);
      const positionIdChanged = baseline == null
        ? value.has(POSITION_ID_KEY)
        : (
            value.has(POSITION_ID_KEY) !== baseline.hasPositionId
            || !Object.is(value.get(POSITION_ID_KEY), baseline.positionId)
          );
      if (positionIdChanged) positionIdChangedIds.add(recordId);

      const legacyMapScalarChanged = baseline == null
        ? rowOrderMap.has(recordId)
        : !Object.is(
            rowOrderMap.get(recordId),
            baseline.rowOrderMapScalar,
          );
      if (legacyMapScalarChanged && !positionIdChanged) {
        legacyRowOrderMapIntentIds.add(recordId);
      }

      const observedLegacyRecordOrderWrite = (
        pendingLegacyRecordOrderWrites?.has(recordId) === true
      );
      const legacyRecordOrderChanged = (
        baseline != null
        && !Object.is(value.get(LEGACY_RECORD_ORDER_FIELD), baseline.legacyOrder)
      );
      if (
        observedLegacyRecordOrderWrite
        || (legacyRecordOrderChanged && !positionIdChanged)
      ) {
        legacyRecordOrderIntentIds.add(recordId);
      }
    });

    const acceptsLegacyArrayIntent = (
      legacyArrayOverride != null
      && positionIdChangedIds.size === 0
      && legacyRecordOrderIntentIds.size === 0
      && legacyRowOrderMapIntentIds.size === 0
    );
    let requestedOrder: readonly string[] | null = null;
    if (legacyRecordOrderIntentIds.size > 0) {
      requestedOrder = resolveLegacyRecordOrderIntent(
        ydoc,
        lastSnapshot,
        legacyRecordOrderIntentIds,
      );
    } else if (legacyRowOrderMapIntentIds.size > 0) {
      requestedOrder = resolveLegacyRowOrder(ydoc, lastSnapshot);
    } else if (acceptsLegacyArrayIntent) {
      requestedOrder = legacyArrayOverride;
    }
    if (!requestedOrder) return;

    // Revert __order-only inputs in the planning clone so a historical NULL
    // row is still recognized as moved even though its current in-memory lift
    // already reflects the just-written legacy scalar.
    const planningDoc = new Y.Doc();
    let plan: ReturnType<typeof planTableRecordOrderReconcile>;
    try {
      Y.applyUpdate(planningDoc, Y.encodeStateAsUpdate(ydoc));
      if (legacyRowOrderMapIntentIds.size > 0) {
        planningDoc.transact(() => {
          const planningMap = planningDoc.getMap(YDOC_ROW_ORDER_MAP);
          const planningRecords = planningDoc.getMap(YDOC_RECORDS);
          for (const recordId of legacyRowOrderMapIntentIds) {
            const baseline = lastSnapshot.recordOrderBaselines.get(recordId);
            if (!baseline || baseline.rowOrderMapScalar === undefined) {
              planningMap.delete(recordId);
            } else {
              planningMap.set(recordId, baseline.rowOrderMapScalar);
            }
            const record = planningRecords.get(recordId);
            if (record instanceof Y.Map && record.has(POSITION_ID_KEY)) {
              // The old scalar is the intent source. Its previous explicit
              // PositionId must not remain the planning truth.
              record.delete(POSITION_ID_KEY);
            }
          }
        }, LEGACY_ROW_ORDER_POSITION_INVALIDATION_ORIGIN);
      }
      if (legacyRecordOrderIntentIds.size > 0) {
        planningDoc.transact(() => {
          const planningRecords = planningDoc.getMap(YDOC_RECORDS);
          for (const recordId of legacyRecordOrderIntentIds) {
            const record = planningRecords.get(recordId);
            const baseline = lastSnapshot.recordOrderBaselines.get(recordId);
            if (!(record instanceof Y.Map) || !baseline) continue;
            if (baseline.legacyOrder === undefined) {
              record.delete(LEGACY_RECORD_ORDER_FIELD);
            } else {
              record.set(LEGACY_RECORD_ORDER_FIELD, baseline.legacyOrder);
            }
          }
        }, LEGACY_ROW_ORDER_POSITION_INVALIDATION_ORIGIN);
      }
      plan = planTableRecordOrderReconcile(
        planningDoc,
        requestedOrder,
        [...legacyRecordOrderIntentIds, ...legacyRowOrderMapIntentIds],
      );
    } finally {
      planningDoc.destroy();
    }

    ydoc.transact(() => {
      applyTableRecordOrderPlan(ydoc, plan);
    }, LEGACY_ROW_ORDER_POSITION_INVALIDATION_ORIGIN);

    if (pendingLegacyRecordOrderWrites) {
      for (const recordId of legacyRecordOrderIntentIds) {
        pendingLegacyRecordOrderWrites.delete(recordId);
      }
      if (pendingLegacyRecordOrderWrites.size === 0) {
        this.pendingLegacyRecordOrderWrites.delete(ydoc);
      }
    }
  }

  protected buildPersistPayload(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): PersistPayload | null {
    const lastSnapshot = this.snapshotCache.get(documentName) as TableSnapshot | undefined;
    if (!lastSnapshot) {
      console.error(
        `[TableDB] Missing snapshot baseline for ${documentName}; refusing full-table persist`,
      );
      throw new MissingTableSnapshotBaselineError(documentName);
    }

    this.removeBlankRecordIdProjections(documentName, ydoc);
    const recordsMap = ydoc.getMap(YDOC_RECORDS);

    const legacyArrayOverride = resolveLegacyArrayOverride(ydoc, lastSnapshot);
    this.reconcileLegacyRecordOrderWrites(ydoc, lastSnapshot, legacyArrayOverride);

    const hasExplicitPositionIds = Array.from(recordsMap.values()).some(
      value => value instanceof Y.Map && value.has(POSITION_ID_KEY),
    );
    const currentRowOrder = hasExplicitPositionIds
      ? getEffectiveTableRecordOrder(ydoc)
      : (legacyArrayOverride ?? resolveLegacyRowOrder(ydoc, lastSnapshot));

    const changedRecords: Record<string, Record<string, unknown>> = {};
    const newRecords: Record<string, Record<string, unknown>> = {};
    const deletedRecordIds: string[] = [];

    const visitedRecordIds = new Set<string>();
    const lifecycleRevalidationIds = this.recordLifecycleRevalidationsByDocument
      .get(documentName);
    if (lifecycleRevalidationIds) {
      for (const recordId of lifecycleRevalidationIds) {
        if (!recordsMap.has(recordId)) lifecycleRevalidationIds.delete(recordId);
      }
      if (lifecycleRevalidationIds.size === 0) {
        this.recordLifecycleRevalidationsByDocument.delete(documentName);
      }
    }

    recordsMap.forEach((value, recordId) => {
      if (!(value instanceof Y.Map)) return;
      visitedRecordIds.add(recordId);

      const lastDigest = lifecycleRevalidationIds?.has(recordId)
        ? undefined
        : lastSnapshot.recordDigests.get(recordId);
      if (!lastDigest) {
        const fieldValues: Record<string, unknown> = {};
        value.forEach((v, k) => { fieldValues[k] = v; });
        newRecords[recordId] = fieldValues;
      } else {
        const currentHash = hashRecordContent(value);
        if (currentHash !== lastDigest.contentHash) {
          const changedFields: Record<string, unknown> = {};
          const currentKeys = new Set<string>();
          value.forEach((v, k) => {
            changedFields[k] = v;
            currentKeys.add(k);
          });
          for (const oldKey of lastDigest.fieldKeys) {
            if (!currentKeys.has(oldKey)) {
              changedFields[oldKey] = null;
            }
          }
          changedRecords[recordId] = changedFields;
        }
      }
    });

    for (const recordId of lastSnapshot.recordDigests.keys()) {
      if (!visitedRecordIds.has(recordId)) deletedRecordIds.push(recordId);
    }

    // : schema undo/resync 后若 Y.Doc records 被掏空、但 snapshot 仍记着旧行，
    // diff 会把「全部行」当成删除；conflict 重试对齐 version 后会真写进 DB。
    // 空文档 + 全量删除视为「推断出的异常缺失 diff」，丢掉 delete。
    // 用户明确删除必须走 REST 权威命令（explicit_delete），不得依赖本路径。
    const snapshotRecordCount = lastSnapshot.recordDigests.size;
    if (
      deletedRecordIds.length > 0
      && recordsMap.size === 0
      && snapshotRecordCount > 0
      && deletedRecordIds.length >= snapshotRecordCount
    ) {
      console.error(
        `[TableDB] refused_inferred_mass_delete for ${documentName}: ` +
          `ydoc records empty but snapshot had ${snapshotRecordCount} digests ` +
          `(explicit_delete must use REST, not inferred collab diff)`,
      );
      deletedRecordIds.length = 0;
    }

    // 新记录必须随 row_order 一起持久化。极端情况下客户端已把记录写入
    // records，但排序 CRDT 尚未包含该 ID；若省略 row_order，Django 只能采用
    // 客户端的临时 __order=0，导致“末尾新增”重载后跳到首行。
    const persistedRowOrder = [...currentRowOrder];
    const orderedRecordIds = new Set(persistedRowOrder);
    for (const recordId of Object.keys(newRecords)) {
      if (orderedRecordIds.has(recordId)) continue;
      persistedRowOrder.push(recordId);
      orderedRecordIds.add(recordId);
    }

    const totalOps = Object.keys(changedRecords).length + Object.keys(newRecords).length + deletedRecordIds.length;
    const rowOrderChanged = JSON.stringify(persistedRowOrder) !== JSON.stringify(lastSnapshot.rowOrder);
    const rowOrderRepresentedByRecordMetadata = [
      ...Object.values(changedRecords),
      ...Object.values(newRecords),
    ].some(record => (
      Object.prototype.hasOwnProperty.call(record, POSITION_ID_KEY)
      && Object.prototype.hasOwnProperty.call(record, LEGACY_RECORD_ORDER_FIELD)
    ));
    const missingNewRecordOrder = persistedRowOrder.length !== currentRowOrder.length;
    const persistLegacyFullRowOrder =
      (rowOrderChanged && !rowOrderRepresentedByRecordMetadata) || missingNewRecordOrder;

    // DC-012: 检测 fields 变更（schema 增删字段）
    const meta = ydoc.getMap(YDOC_META);
    const currentFields = meta.get("fields") as unknown[] | undefined;
    const fieldsChanged = !deepEqual(currentFields, lastSnapshot.fields);
    const viewsMap = ydoc.getMap<unknown>(YDOC_VIEWS);
    const currentViews: Record<string, unknown> = {};
    viewsMap.forEach((value, viewId) => {
      currentViews[viewId] = value;
    });
    const viewsChanged = !deepEqual(currentViews, lastSnapshot.views);

    if (totalOps === 0 && !rowOrderChanged && !fieldsChanged && !viewsChanged) return null;

    const opId = `collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const { editorType, editorId, editorName } = extractEditorInfo(context);
    const persistSource = typeof context.collabRestoreSource === "string"
      ? context.collabRestoreSource
      : "collab_persist";

    const version = (meta.get("version") as number) ?? 0;
    const lifecycleRevalidationCandidates = lifecycleRevalidationIds
      ? Object.keys(newRecords).filter(recordId => lifecycleRevalidationIds.has(recordId))
      : [];
    const recordEditorIds: Record<string, string> = {};
    const recordEditors = this.recordEditorsByDocument.get(documentName);
    for (const recordId of [
      ...Object.keys(changedRecords),
      ...Object.keys(newRecords),
      ...deletedRecordIds,
    ]) {
      const provenance = recordEditors?.get(recordId);
      if (provenance?.editorId) recordEditorIds[recordId] = provenance.editorId;
    }

    return {
      changes: {
        changed_records: changedRecords,
        new_records: newRecords,
        deleted_record_ids: deletedRecordIds,
        ...(persistLegacyFullRowOrder ? { row_order: persistedRowOrder } : {}),
        ...(fieldsChanged && Array.isArray(currentFields) ? { fields: currentFields } : {}),
        ...(viewsChanged ? { views: currentViews } : {}),
        ...(lifecycleRevalidationCandidates.length > 0
          ? { record_lifecycle_revalidation_ids: lifecycleRevalidationCandidates }
          : {}),
        base_version: version,
        op_id: opId,
        source: persistSource,
        editor_type: editorType,
        editor_id: editorId,
        ...(Object.keys(recordEditorIds).length > 0 ? { record_editor_ids: recordEditorIds } : {}),
      },
      op_id: opId,
      editor_type: editorType,
      editor_id: editorId,
      editor_name: editorName,
    };
  }

  protected async buildPersistPayloadAsync(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): Promise<PersistPayload | null> {
    if (!this.snapshotCache.has(documentName)) {
      await this.rebuildMissingSnapshotBaseline(documentName);
    }

    const payload = this.buildPersistPayload(ydoc, documentName, context);
    if (!payload) {
      this.pendingStores.delete(documentName);
      const queuedRevalidations = this.recordLifecycleRevalidationsByDocument
        .get(documentName);
      if (queuedRevalidations) {
        const recordsMap = ydoc.getMap(YDOC_RECORDS);
        for (const recordId of queuedRevalidations) {
          if (!recordsMap.has(recordId)) queuedRevalidations.delete(recordId);
        }
        if (queuedRevalidations.size === 0) {
          this.recordLifecycleRevalidationsByDocument.delete(documentName);
        }
      }
      // 当前状态已经与基准一致，不存在需要防 stale ACK 的在途生命周期。
      this.recordMutationRevisionsByDocument.delete(documentName);
      return null;
    }

    const lastSnapshot = this.snapshotCache.get(documentName) as TableSnapshot | undefined;
    const sentCells = new Map<string, Map<string, unknown>>();
    const outboundRecords = new Map<string, Map<string, unknown>>();
    const recordsMap = ydoc.getMap<unknown>(YDOC_RECORDS);
    const changes = payload.changes as Record<string, unknown>;
    for (const records of [changes.changed_records, changes.new_records]) {
      if (!records || typeof records !== "object" || Array.isArray(records)) continue;
      for (const [recordId, cells] of Object.entries(records)) {
        if (!cells || typeof cells !== "object" || Array.isArray(cells)) continue;
        sentCells.set(recordId, new Map(Object.entries(cells as Record<string, unknown>)));
        const recordMap = recordsMap.get(recordId);
        if (recordMap instanceof Y.Map) {
          const outboundCells = new Map<string, unknown>();
          recordMap.forEach((value, fieldHex) => outboundCells.set(fieldHex, value));
          outboundRecords.set(recordId, outboundCells);
        }
      }
    }
    const pendingStore: PendingTableStore = {
      snapshot: this.captureSnapshot(documentName, ydoc, lastSnapshot),
      sentCells,
      outboundRecords,
      sentRecordEditorRevisions: new Map(),
      sentRecordMutationRevisions: new Map(),
      sentRecordLifecycleRevalidationIds: new Set(),
    };
    const sentLifecycleRevalidationIds = changes.record_lifecycle_revalidation_ids;
    if (Array.isArray(sentLifecycleRevalidationIds)) {
      for (const recordId of sentLifecycleRevalidationIds) {
        if (typeof recordId === "string") {
          pendingStore.sentRecordLifecycleRevalidationIds.add(recordId);
        }
      }
    }
    const deletedRecordIds = Array.isArray(changes.deleted_record_ids)
      ? changes.deleted_record_ids.filter((recordId): recordId is string => typeof recordId === "string")
      : [];
    const sentRecordIds = new Set([...outboundRecords.keys(), ...deletedRecordIds]);
    const recordMutationRevisions = this.recordMutationRevisionsByDocument.get(documentName);
    for (const recordId of sentRecordIds) {
      pendingStore.sentRecordMutationRevisions.set(
        recordId,
        recordMutationRevisions?.get(recordId) ?? 0,
      );
    }
    const sentRecordEditorIds = changes.record_editor_ids;
    if (
      sentRecordEditorIds
      && typeof sentRecordEditorIds === "object"
      && !Array.isArray(sentRecordEditorIds)
    ) {
      const recordEditors = this.recordEditorsByDocument.get(documentName);
      for (const recordId of Object.keys(sentRecordEditorIds as Record<string, unknown>)) {
        const provenance = recordEditors?.get(recordId);
        if (provenance) {
          pendingStore.sentRecordEditorRevisions.set(recordId, provenance.revision);
        }
      }
    }
    if (Array.isArray(changes.fields)) {
      pendingStore.sentFields = changes.fields as unknown[];
    }
    if (changes.views && typeof changes.views === "object" && !Array.isArray(changes.views)) {
      pendingStore.sentViews = changes.views as Record<string, unknown>;
    }
    this.pendingStores.set(documentName, pendingStore);
    return payload;
  }

  private async rebuildMissingSnapshotBaseline(documentName: string): Promise<void> {
    const resourceId = this.parseId(documentName);
    if (!resourceId) {
      throw new MissingTableSnapshotBaselineError(documentName);
    }

    console.warn(
      `[TableDB] Missing snapshot baseline for ${documentName}; rebuilding from authoritative snapshot`,
    );
    const snapshot = await withRetry(
      () => fetchCollabSnapshot(this.getResourceType(), resourceId),
      { label: "TableDB-BaselineRecovery", maxRetries: 2 },
    ) as Record<string, unknown>;

    if (isIncompleteAuthoritativeRecordSnapshot(snapshot)) {
      throw new Error(
        `Cannot rebuild complete snapshot baseline for ${documentName}`,
      );
    }

    const baselineDoc = new Y.Doc();
    try {
      await this.applySnapshotToDocAsync(baselineDoc, snapshot);
      this.onSnapshotLoaded(documentName, baselineDoc);
    } finally {
      baselineDoc.destroy();
    }

    if (!this.snapshotCache.has(documentName)) {
      throw new MissingTableSnapshotBaselineError(documentName);
    }
  }

  protected onStoreConflict(ydoc: Y.Doc, _documentName: string, conflictResult: Record<string, unknown>): void {
    const serverVersion = (conflictResult.current_version ?? conflictResult.current_revn) as number | undefined;
    if (serverVersion != null) {
      ydoc.getMap(YDOC_META).set("version", serverVersion);
    }
    // CR-020: 不操作 snapshotCache——conflict 时的快照可能与 Django 端不一致，
    // 保留旧 snapshotCache 让 retry 的 diff 包含实际变更而非空集。
  }

  protected onStoreSuccess(ydoc: Y.Doc, documentName: string, result: unknown): void {
    const resultObj = result as Record<string, unknown> | undefined;
    const meta = ydoc.getMap(YDOC_META);
    const pendingStore = this.pendingStores.get(documentName);

    const newVersion = resultObj?.version as number | undefined;
    if (newVersion != null) {
      meta.set("version", newVersion);
    }

    const newFields = resultObj?.fields as unknown[] | undefined;
    if (Array.isArray(newFields) && newFields.length > 0) {
      const currentFields = meta.get("fields");
      const canApplyFields = !pendingStore || (
        pendingStore.sentFields !== undefined
        && deepEqual(currentFields, pendingStore.sentFields)
      );
      if (canApplyFields) {
        meta.set("fields", newFields);
        if (pendingStore) pendingStore.snapshot.fields = newFields;
      } else {
        console.info(
          `[TableDB] Skipped stale fields ACK for ${documentName}; ` +
          `schema changed while persist was in flight`,
        );
      }
    }

    const newViews = resultObj?.views as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(newViews)) {
      const viewsMap = ydoc.getMap<unknown>(YDOC_VIEWS);
      const viewOrderMap = ydoc.getMap<number>(YDOC_VIEW_ORDER_MAP);
      const currentViews: Record<string, unknown> = {};
      viewsMap.forEach((view, viewId) => {
        currentViews[viewId] = view;
      });
      const canApplyViews = !pendingStore || (
        pendingStore.sentViews !== undefined
        && deepEqual(currentViews, pendingStore.sentViews)
      );
      if (canApplyViews) {
        const incomingIds = new Set<string>();
        const acknowledgedViews: Record<string, unknown> = {};
        ydoc.transact(() => {
          newViews.forEach((view, index) => {
            const viewId = typeof view.id === "string" ? view.id : "";
            if (!viewId) return;
            incomingIds.add(viewId);
            acknowledgedViews[viewId] = view;
            viewsMap.set(viewId, view);
            viewOrderMap.set(viewId, typeof view.order === "number" ? view.order : index);
          });
          Array.from(viewsMap.keys()).forEach((viewId) => {
            if (!incomingIds.has(viewId)) viewsMap.delete(viewId);
          });
          Array.from(viewOrderMap.keys()).forEach((viewId) => {
            if (!incomingIds.has(viewId)) viewOrderMap.delete(viewId);
          });
        });
        if (pendingStore) pendingStore.snapshot.views = acknowledgedViews;
      } else {
        console.info(
          `[TableDB] Skipped stale views ACK for ${documentName}; ` +
          `views changed while persist was in flight`,
        );
      }
    }

    // 系统时间字段（created_time / last_modified_time）值存于 Django 系统列、不在用户 cell。
    // Django persist 后按字段 hex 回写，这里写进 Y.Doc records，使前端协作投影即时携带
    // 创建/修改时间，消除看板/grid 新建时「闪一下又消失」。在 saveSnapshot 前写入，
    // 保证这些 cell 进入快照基准（后续 diff 不误判、reconcile 不清除）。
    const systemCells = resultObj?.record_system_cells as
      | Record<string, Record<string, unknown>>
      | undefined;
    // 子记录父链等被服务端拒绝/重建的权威 cell，回写以免 Y.Doc 仍显示超深层级。
    const cellCorrections = resultObj?.record_cell_corrections as
      | Record<string, Record<string, unknown>>
      | undefined;
    const discardedRecordUpdates = resultObj?.discarded_record_updates as
      | Array<Record<string, unknown>>
      | undefined;
    const discardedNewRecordIds = resultObj?.discarded_new_record_ids as
      | string[]
      | undefined;
    const unconfirmedRecordLifecycleIds = resultObj?.unconfirmed_record_lifecycle_ids as
      | string[]
      | undefined;
    const unconfirmedRecordLifecycleIdSet = new Set(
      Array.isArray(unconfirmedRecordLifecycleIds)
        ? unconfirmedRecordLifecycleIds.filter(
          (recordId): recordId is string => typeof recordId === "string" && recordId.length > 0,
        )
        : [],
    );
    const retainedDiscardedLifecycleIds = new Set<string>();

    if (pendingStore && unconfirmedRecordLifecycleIdSet.size > 0) {
      for (const recordId of pendingStore.sentRecordLifecycleRevalidationIds) {
        if (unconfirmedRecordLifecycleIdSet.has(recordId)) {
          // Keep the projection, but never advance its digest baseline. The
          // next store must re-run the fail-closed Django lifecycle check.
          pendingStore.snapshot.recordDigests.delete(recordId);
        }
      }
    }

    // delete-wins 的保存 ACK 是一次性业务反馈，不属于 records diff。写入 meta 的最新事件槽位，
    // 由客户端按 target_editor_id 定向消费；created_at 让重连客户端只补发 TTL 内的新事件。
    if (Array.isArray(discardedRecordUpdates) && discardedRecordUpdates.length > 0) {
      const receivedAt = Date.now();
      meta.set(
        "discarded_record_updates",
        discardedRecordUpdates.map((notice) => ({
          ...notice,
          created_at: typeof notice.created_at === "number" ? notice.created_at : receivedAt,
        })),
      );
    }

    if (Array.isArray(discardedNewRecordIds) && discardedNewRecordIds.length > 0) {
      const recordsMap = ydoc.getMap(YDOC_RECORDS);
      const rowOrderMap = ydoc.getMap(YDOC_ROW_ORDER_MAP);
      const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER);
      const removedRecordIds = new Set<string>();
      const discardedBaselineRecordIds = new Set<string>();

      ydoc.transact(() => {
        for (const recordId of discardedNewRecordIds) {
          if (typeof recordId !== "string" || !recordId) continue;
          const outboundCells = pendingStore?.outboundRecords.get(recordId);
          if (pendingStore && !outboundCells) {
            console.warn(
              `[TableDB] Ignored unexpected discarded new-record ACK for ${recordId}; ` +
              `record was not part of the outbound persist`,
            );
            continue;
          }

          const currentRecord = recordsMap.get(recordId);
          const currentMutationRevision = this.recordMutationRevisionsByDocument
            .get(documentName)
            ?.get(recordId) ?? 0;
          const sentMutationRevision = pendingStore?.sentRecordMutationRevisions
            .get(recordId) ?? 0;
          const canRemoveCurrentProjection = !pendingStore
            || !(currentRecord instanceof Y.Map)
            || (
              currentMutationRevision === sentMutationRevision
              && recordMatchesOutboundCells(currentRecord, outboundCells!)
            );
          if (canRemoveCurrentProjection) {
            recordsMap.delete(recordId);
            rowOrderMap.delete(recordId);
            removedRecordIds.add(recordId);
          } else {
            if (pendingStore?.sentRecordLifecycleRevalidationIds.has(recordId)) {
              retainedDiscardedLifecycleIds.add(recordId);
            }
            console.info(
              `[TableDB] Kept concurrently changed rejected record ${recordId}; ` +
              `the next persist will revalidate its lifecycle`,
            );
          }

          // 服务端已拒绝该生命周期，因此 ACK 基准中必须移除。若请求在途期间
          // 又发生编辑，当前投影会在下一轮继续作为 new_record 送服务端重验。
          if (pendingStore) {
            pendingStore.snapshot.recordDigests.delete(recordId);
            pendingStore.snapshot.recordOrderBaselines.delete(recordId);
            discardedBaselineRecordIds.add(recordId);
            pendingStore.sentCells.delete(recordId);
            pendingStore.outboundRecords.delete(recordId);
            pendingStore.sentRecordEditorRevisions.delete(recordId);
            pendingStore.sentRecordMutationRevisions.delete(recordId);
          }
        }

        if (pendingStore && discardedBaselineRecordIds.size > 0) {
          pendingStore.snapshot.rowOrder = pendingStore.snapshot.rowOrder.filter(
            recordId => !discardedBaselineRecordIds.has(recordId),
          );
        }

        if (removedRecordIds.size > 0) {
          const legacyOrder = rowOrder.toArray();
          for (let index = legacyOrder.length - 1; index >= 0; index -= 1) {
            if (removedRecordIds.has(legacyOrder[index])) rowOrder.delete(index, 1);
          }
        }
      });

      const recordEditors = this.recordEditorsByDocument.get(documentName);
      for (const recordId of removedRecordIds) recordEditors?.delete(recordId);
      if (recordEditors?.size === 0) this.recordEditorsByDocument.delete(documentName);
      const recordMutationRevisions = this.recordMutationRevisionsByDocument.get(documentName);
      for (const recordId of removedRecordIds) recordMutationRevisions?.delete(recordId);
      if (recordMutationRevisions?.size === 0) {
        this.recordMutationRevisionsByDocument.delete(documentName);
      }
    }

    const recordsToPatch: Array<[
      string,
      Record<string, unknown>,
      "system" | "correction",
    ]> = [];
    if (systemCells) {
      for (const entry of Object.entries(systemCells)) {
        recordsToPatch.push([entry[0], entry[1], "system"]);
      }
    }
    if (cellCorrections) {
      for (const [recordId, cells] of Object.entries(cellCorrections)) {
        recordsToPatch.push([recordId, cells, "correction"]);
      }
    }

    if (recordsToPatch.length > 0) {
      const recordsMap = ydoc.getMap(YDOC_RECORDS);
      ydoc.transact(() => {
        for (const [recordId, cells, source] of recordsToPatch) {
          const recordMap = recordsMap.get(recordId);
          if (!(recordMap instanceof Y.Map)) continue;
          for (const [fieldHex, cellValue] of Object.entries(cells)) {
            if (source === "correction" && pendingStore) {
              const sentRecord = pendingStore.sentCells.get(recordId);
              const sentValue = sentRecord?.get(fieldHex);
              const currentValue = (recordMap as Y.Map<unknown>).get(fieldHex);
              const stillMatchesSent = sentRecord?.has(fieldHex) && (
                deepEqual(currentValue, sentValue)
                || (sentValue === null && currentValue === undefined)
              );
              if (!stillMatchesSent) {
                console.info(
                  `[TableDB] Skipped stale cell correction for ${recordId}/${fieldHex}; ` +
                  `cell changed while persist was in flight`,
                );
                continue;
              }
            }
            if (cellValue === null || cellValue === undefined) {
              (recordMap as Y.Map<unknown>).delete(fieldHex);
            } else {
              (recordMap as Y.Map<unknown>).set(fieldHex, cellValue);
            }

            const outboundCells = pendingStore?.outboundRecords.get(recordId);
            if (pendingStore && outboundCells) {
              if (cellValue === null || cellValue === undefined) {
                outboundCells.delete(fieldHex);
              } else {
                outboundCells.set(fieldHex, cellValue);
              }
              pendingStore.snapshot.recordDigests.set(
                recordId,
                digestRecordCells(outboundCells),
              );
            }
          }
        }
      });
    }

    if (pendingStore) {
      const currentRecordEditors = this.recordEditorsByDocument.get(documentName);
      for (const [recordId, sentRevision] of pendingStore.sentRecordEditorRevisions) {
        if (currentRecordEditors?.get(recordId)?.revision === sentRevision) {
          currentRecordEditors.delete(recordId);
        }
      }
      if (currentRecordEditors?.size === 0) {
        this.recordEditorsByDocument.delete(documentName);
      }
      const currentMutationRevisions = this.recordMutationRevisionsByDocument.get(documentName);
      for (const [recordId, sentRevision] of pendingStore.sentRecordMutationRevisions) {
        if (currentMutationRevisions?.get(recordId) === sentRevision) {
          currentMutationRevisions.delete(recordId);
        }
      }
      if (currentMutationRevisions?.size === 0) {
        this.recordMutationRevisionsByDocument.delete(documentName);
      }
      const queuedRevalidations = this.recordLifecycleRevalidationsByDocument
        .get(documentName);
      for (const recordId of pendingStore.sentRecordLifecycleRevalidationIds) {
        if (
          !unconfirmedRecordLifecycleIdSet.has(recordId)
          && !retainedDiscardedLifecycleIds.has(recordId)
        ) {
          queuedRevalidations?.delete(recordId);
        }
      }
      if (queuedRevalidations?.size === 0) {
        this.recordLifecycleRevalidationsByDocument.delete(documentName);
      }
      this.snapshotCache.set(documentName, pendingStore.snapshot);
      this.pendingStores.delete(documentName);
    } else {
      // 兼容非 store 管线的显式成功回调与现有内部调用。
      this.saveSnapshot(documentName, ydoc);
    }
  }

  protected onStoreFailure(documentName: string): void {
    this.pendingStores.delete(documentName);
  }

  public clearSnapshot(documentName: string): void {
    this.snapshotCache.delete(documentName);
    this.pendingStores.delete(documentName);
    this.recordEditorsByDocument.delete(documentName);
    this.recordMutationRevisionsByDocument.delete(documentName);
    this.recordLifecycleRevalidationsByDocument.delete(documentName);
  }

  protected retainSnapshotOnUnloadTimeout(): boolean {
    return true;
  }

  protected logStoreSuccess(resourceId: string, result: any, latencyMs: number): void {
    console.log(
      `[TableDB] Persisted changes for table ${resourceId}: ` +
      `changed=${result.persisted} created=${result.created} deleted=${result.deleted} ` +
      `version=${result.version} (${latencyMs}ms)`,
    );
  }

}

/** 外部 API：保存 Table 快照（供 Agent push 路由调用） */
export function saveTableSnapshot(documentName: string, ydoc: Y.Doc): void {
  if (!singletonInstance) {
    console.warn(`[TableDB] saveTableSnapshot called but singleton is null, snapshot for "${documentName}" will not be saved`);
    return;
  }
  singletonInstance.saveSnapshot(documentName, ydoc);
}

export function clearTableSnapshot(documentName: string): void {
  singletonInstance?.clearSnapshot(documentName);
}

/**
 * Force selected rows through Django lifecycle classification on the next store.
 * This changes only the diff baseline; it does not mutate the Y.Doc or business DB.
 */
export function queueTableRecordLifecycleRevalidation(
  documentName: string,
  recordIds: string[],
): number {
  if (!singletonInstance) {
    throw new Error("TableDB singleton is not initialized");
  }
  return singletonInstance.queueRecordLifecycleRevalidation(documentName, recordIds);
}

/**
 * 将 schema 变更事件中的 fields 更新到 Y.Doc meta.fields。
 * 由 admin.ts stateless-broadcast 端点调用，当事件为 table.schema.changed 时触发。
 */
export function updateTableMetaFields(ydoc: Y.Doc, fields: unknown[]): void {
  const meta = ydoc.getMap(YDOC_META);
  meta.set("fields", fields);
}
