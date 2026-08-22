/**
 * Canvas Database Extension（V2 records-only）
 *
 * TabWhiteboard 的 Hocuspocus 持久化扩展，继承 BaseCollabDatabase。
 *
 * Y.Doc 数据模型（V2 records-only）：
 *   records:  Y.Map<recordId, Y.Map<prop, value>>   — shape / binding / page / camera 一元
 *   meta:     Y.Map  — { canvasId, name, canvasType, version, currentPageId }
 *
 * Wave 5 W5-Purge：删除全部 V1 legacy helper（mergeGraphIntoDoc / docToGraph /
 * docToPages / buildCanvasSnapshot / normalizeNodeForPersist / normalizeEdgeForPersist
 * 等）。生产路径 + 测试路径只走 records + meta。
 */

import * as Y from "yjs";
import { BaseCollabDatabase, type PersistPayload } from "./base-collab-database.js";
import { extractEditorInfo } from "../lib/collab-utils.js";

const YDOC_RECORDS = "records";
const YDOC_META = "meta";

/**
 * V2 records-only schema 版本号。
 *
 * 字面值 2 是 V2 records-only schema 版本。服务端只需这个数字常量，
 * 不拉前端白板包。升 schema 时需要同步改契约测试。
 */
const CURRENT_SCHEMA_VERSION = 2;

const SNAPSHOT_BATCH_SIZE = 100;

function yieldEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface CanvasSnapshot {
  records: Record<string, unknown>[];
  meta: { name?: string; canvasType?: string };
}

function encodeRecordField(key: string, value: unknown): unknown {
  if ((key === "props" || key === "meta") && value != null && typeof value === "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  if (value != null && typeof value === "object") return JSON.stringify(value);
  return value;
}

function decodeRecordField(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (key !== "props" && key !== "meta") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function yRecordToPlain(record: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  record.forEach((value, key) => {
    out[key] = decodeRecordField(key, value);
  });
  return out;
}

function writeRecordFields(recordYMap: Y.Map<unknown>, record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    recordYMap.set(key, encodeRecordField(key, value));
  }
}

function applyRecordsToDoc(doc: Y.Doc, records: Record<string, unknown>[]): number {
  const recordsMap = doc.getMap(YDOC_RECORDS);
  let applied = 0;
  for (const record of records) {
    const id = record.id as string | undefined;
    if (!id) continue;
    const recordYMap = new Y.Map<unknown>();
    writeRecordFields(recordYMap, record);
    recordsMap.set(id, recordYMap);
    applied++;
  }
  return applied;
}

function normalizeLegacyId(value: unknown): string {
  return typeof value === "string" ? value.replace(/^shape:/, "") : "";
}

/**
 * V1 legacy node.type → V2 shape typeName / geo 翻译表。仅 graphToRecords 使用。
 *
 * 保留 V1 → V2 翻译以兼容旧 Agent body（仍带 nodes/edges 字段）：
 * V2-only 收敛后 Agent 工具内部已统一走 records，但旧版 SDK / 直接 HTTP 调用
 * 仍可能传 nodes/edges，agent-push 入口透过 graphToRecords 立即转 records。
 */
function legacyNodeTypeToRecord(nodeType: string | undefined): { typeName: string; geo?: string; legacyType?: string } {
  switch (nodeType) {
    case "topic": return { typeName: "shape:topic" };
    case "note": return { typeName: "shape:note" };
    case "geo": return { typeName: "shape:geo" };
    case "group": return { typeName: "shape:group" };
    case "annotation": return { typeName: "shape:annotation" };
    case "image": return { typeName: "shape:image" };
    case "embed": return { typeName: "shape:embed" };
    case "draw": return { typeName: "shape:draw" };
    case "text": return { typeName: "shape:text" };
    case "process":
    case "queue":
    case "service":
    case "cloud":
      return { typeName: "shape:geo", geo: "rectangle", legacyType: nodeType };
    case "decision":
      return { typeName: "shape:geo", geo: "diamond", legacyType: nodeType };
    case "start":
    case "end":
    case "user":
      return { typeName: "shape:geo", geo: "ellipse", legacyType: nodeType };
    case "io":
      return { typeName: "shape:geo", geo: "parallelogram", legacyType: nodeType };
    case "database":
      return { typeName: "shape:geo", geo: "cylinder", legacyType: nodeType };
    default:
      return { typeName: "shape:default" };
  }
}

/**
 * Agent legacy body（nodes / edges）→ V2 records 翻译桥。
 *
 * agent-push.ts 现在只走 records 通道，但保留这个 helper 让旧 Agent body（仍带
 * nodes / edges）能自动翻译为 records 推送到 Y.Doc。
 */
export function graphToRecords(
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [
    { typeName: "page", id: "page:p1", props: { name: "页面 1", index: "a0" }, meta: {} },
    { typeName: "camera", id: "camera:page:p1", x: 0, y: 0, props: { z: 1, pageId: "page:p1" }, meta: {} },
  ];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    const nodeId = node.id as string | undefined;
    if (!nodeId) continue;
    const position = node.position as Record<string, unknown> | undefined;
    const data = node.data as Record<string, unknown> | undefined;
    const typeInfo = legacyNodeTypeToRecord(node.type as string | undefined);
    const props = { ...(data ?? {}) };
    if (typeInfo.geo && props.geo == null) props.geo = typeInfo.geo;
    if (typeInfo.legacyType && props.legacyType == null) props.legacyType = typeInfo.legacyType;
    records.push({
      typeName: typeInfo.typeName,
      id: nodeId.startsWith("shape:") ? nodeId : `shape:${nodeId}`,
      parentId: (node.parentId as string | undefined) ?? "page:p1",
      index: (node.index as string | undefined) ?? `a${index + 1}`,
      x: position?.x ?? node.x ?? 0,
      y: position?.y ?? node.y ?? 0,
      props,
      meta: {},
    });
  }
  for (const edge of edges) {
    const source = normalizeLegacyId(edge.source ?? edge.fromShapeId);
    const target = normalizeLegacyId(edge.target ?? edge.toShapeId);
    if (!source || !target) continue;
    const edgeId = edge.id as string | undefined;
    const data = edge.data as Record<string, unknown> | undefined;
    records.push({
      typeName: "binding:arrow",
      id: edgeId?.startsWith("binding:") ? edgeId : `binding:${edgeId ?? `${source}_${target}`}`,
      fromShapeId: `shape:${source}`,
      toShapeId: `shape:${target}`,
      props: {
        arrowType: (edge.type as string | undefined) ?? "default",
        ...(edge.label ? { label: edge.label } : {}),
        ...(data ?? {}),
      },
      meta: {},
    });
  }
  return records;
}

export function docToRecords(doc: Y.Doc): Record<string, unknown>[] {
  const recordsMap = doc.getMap(YDOC_RECORDS);
  const records: Record<string, unknown>[] = [];
  recordsMap.forEach((value: unknown) => {
    if (value instanceof Y.Map) records.push(yRecordToPlain(value));
  });
  return records;
}

function cleanupOrphanBindings(doc: Y.Doc): string[] {
  const recordsMap = doc.getMap(YDOC_RECORDS);
  const shapeIds = new Set<string>();
  const orphanIds: string[] = [];
  recordsMap.forEach((value, id) => {
    if (value instanceof Y.Map && String(value.get("typeName")).startsWith("shape:")) {
      shapeIds.add(id);
    }
  });
  recordsMap.forEach((value, id) => {
    if (!(value instanceof Y.Map) || value.get("typeName") !== "binding:arrow") return;
    const props = decodeRecordField("props", value.get("props"));
    const propsObj = props != null && typeof props === "object" ? props as Record<string, unknown> : {};
    const fromShapeId = value.get("fromShapeId") ?? propsObj.fromShapeId;
    const toShapeId = value.get("toShapeId") ?? propsObj.toShapeId;
    if (typeof fromShapeId !== "string" || typeof toShapeId !== "string") {
      orphanIds.push(id);
    } else if (!shapeIds.has(fromShapeId) || !shapeIds.has(toShapeId)) {
      orphanIds.push(id);
    }
  });
  if (orphanIds.length > 0) {
    for (const id of orphanIds) recordsMap.delete(id);
  }
  return orphanIds;
}

/**
 * 将 canvas snapshot 写入 Y.Doc（V2 records-only 生产路径）。
 *
 * 只处理 records + meta；W5-Purge 后 V1 legacy 字段（nodes / edges / viewport / theme /
 * pages / pageOrder / layoutConfig）不再被写入或读取。
 */
function applySnapshotToDoc(
  doc: Y.Doc,
  snapshot: {
    records?: unknown[];
    meta?: Record<string, unknown>;
  },
): void {
  const metaMap = doc.getMap(YDOC_META);

  if (Array.isArray(snapshot.records)) {
    applyRecordsToDoc(doc, snapshot.records as Record<string, unknown>[]);
    cleanupOrphanBindings(doc);
  }

  if (snapshot.meta) {
    for (const [k, v] of Object.entries(snapshot.meta)) {
      metaMap.set(k, v);
    }
  }
}

/**
 * applySnapshotToDoc 的异步分批版本（V2 records-only）。
 *
 * 只批量写 records（每 SNAPSHOT_BATCH_SIZE 条让出事件循环），最后 transact 一次 meta。
 */
async function applySnapshotToDocBatched(
  doc: Y.Doc,
  snapshot: {
    records?: unknown[];
    meta?: Record<string, unknown>;
  },
): Promise<void> {
  if (Array.isArray(snapshot.records)) {
    const records = snapshot.records as Record<string, unknown>[];
    for (let i = 0; i < records.length; i += SNAPSHOT_BATCH_SIZE) {
      const batch = records.slice(i, i + SNAPSHOT_BATCH_SIZE);
      doc.transact(() => {
        applyRecordsToDoc(doc, batch);
      });
      if (i + SNAPSHOT_BATCH_SIZE < records.length) {
        await yieldEventLoop();
      }
    }
    cleanupOrphanBindings(doc);
  }

  doc.transact(() => {
    const metaMap = doc.getMap(YDOC_META);
    if (snapshot.meta) {
      for (const [k, v] of Object.entries(snapshot.meta)) {
        metaMap.set(k, v);
      }
    }
  });
}

/**
 * 构建 records-only 快照（生产路径），用于 _pendingSnapshots / snapshotCache / digest 比较。
 */
function buildRecordsSnapshot(doc: Y.Doc): CanvasSnapshot {
  const records = docToRecords(doc);
  const metaMap = doc.getMap(YDOC_META);
  const name = metaMap.get("name") as string | undefined;
  const canvasType = metaMap.get("canvasType") as string | undefined;
  const meta: { name?: string; canvasType?: string } = {};
  if (typeof name === "string") meta.name = name;
  if (typeof canvasType === "string") meta.canvasType = canvasType;
  return { records, meta };
}

/**
 * V2 records 合并主路径。
 *
 * mode:
 *   - merge（默认）：按 id merge 覆盖字段
 *   - replace：先 clear records map 再写入新 records
 *   - delete：从 recordIds 列表中删除对应 records
 *
 * meta.currentPageId 写入 meta map（V2 生产路径会读）。其他 meta 字段 V2-only
 * 后不再写入 Y.Doc，调用方传也不报错（兼容）。
 */
export function mergeRecordsIntoDoc(
  doc: Y.Doc,
  incomingRecords: Record<string, unknown>[],
  optionsOrOrigin?: "merge" | "replace" | "delete" | {
    mode?: "merge" | "replace" | "delete";
    recordIds?: string[];
    meta?: Record<string, unknown>;
  },
  origin?: string,
): { recordsApplied: number; recordsDeleted: number } {
  const options = typeof optionsOrOrigin === "object" && optionsOrOrigin !== null
    ? optionsOrOrigin
    : (
        optionsOrOrigin === "merge" || optionsOrOrigin === "replace" || optionsOrOrigin === "delete"
          ? { mode: optionsOrOrigin }
          : { mode: "merge" as const }
      );
  const mode = options.mode ?? "merge";
  const transactOrigin = typeof optionsOrOrigin === "string" && !["merge", "replace", "delete"].includes(optionsOrOrigin)
    ? optionsOrOrigin
    : origin;
  let recordsApplied = 0;
  let recordsDeleted = 0;
  doc.transact(() => {
    const recordsMap = doc.getMap(YDOC_RECORDS);
    if (mode === "replace") {
      recordsDeleted += recordsMap.size;
      recordsMap.clear();
    }
    if (mode === "delete") {
      const ids = options.recordIds ?? incomingRecords.map((record) => record.id as string).filter(Boolean);
      for (const id of ids) {
        if (recordsMap.has(id)) recordsDeleted++;
        recordsMap.delete(id);
      }
    } else {
      for (const record of incomingRecords) {
        const recordId = record.id as string | undefined;
        if (!recordId) continue;
        let existing = recordsMap.get(recordId) as Y.Map<unknown> | undefined;
        if (!(existing instanceof Y.Map)) {
          existing = new Y.Map<unknown>();
          recordsMap.set(recordId, existing);
        }
        writeRecordFields(existing, record);
        recordsApplied++;
      }
    }
    // meta.currentPageId 写入 meta map（V2 生产路径会读）；
    // 老 Agent body 中的 viewport / theme / pages / pageOrder / layoutConfig 不再写入 Y.Doc。
    if (options.meta && typeof options.meta === "object") {
      const currentPageId = options.meta.currentPageId ?? options.meta.current_page_id;
      if (typeof currentPageId === "string") {
        doc.getMap(YDOC_META).set("currentPageId", currentPageId);
      }
    }
    cleanupOrphanBindings(doc);
  }, transactOrigin);
  return { recordsApplied, recordsDeleted };
}

export class CanvasDatabase extends BaseCollabDatabase {
  /**
   * CC-012: buildPersistPayload 暂存已构建的快照，供 onStoreSuccess 复用，
   * 避免二次全量序列化。按 documentName 索引以支持多文档并发。
   */
  private readonly _pendingSnapshots = new Map<string, CanvasSnapshot>();

  /**
   * CI-006: records 摘要缓存。JSON.stringify(records) 字符串比较替代 O(N×M) 递归 deepEqual。
   */
  private readonly _recordsDigest = new Map<string, string>();

  protected getPrefix(): string { return "canvas:"; }
  protected getResourceType(): string { return "canvas"; }
  protected getModuleLabel(): string { return "CanvasDB"; }

  /**
   * V2 records-only 下 records map 并发合并天然 LWW，无需预清空。
   */
  protected prepareYDocForMerge(_ydoc: Y.Doc): void {
    // no-op
  }

  protected applySnapshotToDoc(initDoc: Y.Doc, snapshot: Record<string, unknown>): void {
    const canvasId = (snapshot.canvas_id ?? snapshot.id ?? "") as string;
    const meta = snapshot.meta as Record<string, unknown> | undefined;
    applySnapshotToDoc(initDoc, {
      records: (snapshot.records_data ?? snapshot.records ?? []) as unknown[],
      meta: {
        canvasId,
        name: (snapshot.name ?? snapshot.canvas_name ?? (meta?.name as string) ?? "") as string,
        canvasType: ((snapshot.canvas_type ?? meta?.canvas_type) as string) ?? "mindmap",
        version: (snapshot.latest_version ?? snapshot.version ?? (meta?.version as number) ?? 0) as number,
      },
    });
  }

  protected onSnapshotLoaded(documentName: string, initDoc: Y.Doc, _snapshot: Record<string, unknown>): void {
    const snapshot = buildRecordsSnapshot(initDoc);
    this.snapshotCache.set(documentName, snapshot);
    this._recordsDigest.set(documentName, JSON.stringify(snapshot.records));
  }

  protected buildPersistPayload(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): PersistPayload | null {
    const metaMap = ydoc.getMap(YDOC_META);
    const version = (metaMap.get("version") as number) ?? 0;

    const records = docToRecords(ydoc);
    const currentRecordsDigest = JSON.stringify(records);
    const lastSnapshot = this.snapshotCache.get(documentName) as CanvasSnapshot | undefined;
    const lastRecordsDigest = this._recordsDigest.get(documentName);

    const currentName = metaMap.get("name") as string | undefined;
    const currentCanvasType = metaMap.get("canvasType") as string | undefined;
    const nameChanged = typeof currentName === "string" && currentName !== lastSnapshot?.meta?.name;
    const canvasTypeChanged = typeof currentCanvasType === "string" && currentCanvasType !== lastSnapshot?.meta?.canvasType;
    const recordsChanged = !lastSnapshot || lastRecordsDigest !== currentRecordsDigest;

    if (!recordsChanged && !nameChanged && !canvasTypeChanged) {
      return null;
    }

    const snapshotMeta: { name?: string; canvasType?: string } = {};
    if (typeof currentName === "string") snapshotMeta.name = currentName;
    if (typeof currentCanvasType === "string") snapshotMeta.canvasType = currentCanvasType;
    this._pendingSnapshots.set(documentName, { records, meta: snapshotMeta });

    const { editorType, editorId, editorName } = extractEditorInfo(context);
    // E2E-021: 生成 op_id 启用 Django 幂等缓存，防止 HTTP 响应丢失后重试导致重复写入
    const opId = `canvas_collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const metaPayload: Record<string, unknown> = {};
    if (nameChanged) metaPayload.name = currentName;
    if (canvasTypeChanged) metaPayload.canvas_type = currentCanvasType;

    const changes: Record<string, unknown> = {
      records_data: records,
      base_version: version,
      schema_version: CURRENT_SCHEMA_VERSION,
    };
    if (Object.keys(metaPayload).length > 0) changes.meta = metaPayload;

    return {
      changes,
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
    // 复用 buildPersistPayload 已构建的快照，避免二次全量序列化
    const pending = this._pendingSnapshots.get(documentName);
    const snapshot = pending ?? buildRecordsSnapshot(ydoc);
    if (pending) this._pendingSnapshots.delete(documentName);
    this.snapshotCache.set(documentName, snapshot);
    this._recordsDigest.set(documentName, JSON.stringify(snapshot.records));
  }

  protected onStoreConflict(ydoc: Y.Doc, documentName: string, conflictResult: Record<string, unknown>): void {
    const serverVersion = conflictResult.current_version as number | undefined;
    if (serverVersion != null) {
      ydoc.getMap(YDOC_META).set("version", serverVersion);
    }
    // CC-013 / CR-020: 不写入 snapshotCache。base class 在 onStoreConflict 后调用
    // buildPersistPayload 构建 retry payload，如果此处写入当前 Y.Doc 快照，
    // buildPersistPayload 会判断"无变更"返回 null，短路冲突重试机制。
    this._pendingSnapshots.delete(documentName);
    this._recordsDigest.delete(documentName);
  }

  // ─── 异步分批版本（records-only） ──────────────────────

  protected async applySnapshotToDocAsync(initDoc: Y.Doc, snapshot: Record<string, unknown>): Promise<void> {
    const canvasId = (snapshot.canvas_id ?? snapshot.id ?? "") as string;
    const meta = snapshot.meta as Record<string, unknown> | undefined;
    await applySnapshotToDocBatched(initDoc, {
      records: (snapshot.records_data ?? snapshot.records ?? []) as unknown[],
      meta: {
        canvasId,
        name: (snapshot.name ?? snapshot.canvas_name ?? (meta?.name as string) ?? "") as string,
        canvasType: ((snapshot.canvas_type ?? meta?.canvas_type) as string) ?? "mindmap",
        version: (snapshot.latest_version ?? snapshot.version ?? (meta?.version as number) ?? 0) as number,
      },
    });
  }

  protected async buildPersistPayloadAsync(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): Promise<PersistPayload | null> {
    // V2 records-only 后 records 序列化已不需要分批（records 数量远小于 V1 nodes/edges 合计），
    // 直接复用同步版本。如需进一步分批，可在此处把 docToRecords 改成 docToRecordsAsync。
    return this.buildPersistPayload(ydoc, documentName, context);
  }

  protected async onStoreSuccessAsync(ydoc: Y.Doc, documentName: string, result: unknown): Promise<void> {
    this.onStoreSuccess(ydoc, documentName, result);
  }

  protected async onStoreConflictAsync(ydoc: Y.Doc, documentName: string, conflictResult: Record<string, unknown>): Promise<void> {
    this.onStoreConflict(ydoc, documentName, conflictResult);
  }

  protected clearSnapshot(documentName: string): void {
    this._pendingSnapshots.delete(documentName);
    this._recordsDigest.delete(documentName);
  }

  protected logStoreSuccess(resourceId: string, result: unknown, latencyMs: number): void {
    const r = result as Record<string, unknown> | undefined;
    console.log(
      `[CanvasDB] Persisted canvas ${resourceId}: ` +
      `version=${r?.version} (${latencyMs}ms)`,
    );
  }
}

export function createCanvasDatabase(): CanvasDatabase {
  return new CanvasDatabase();
}
