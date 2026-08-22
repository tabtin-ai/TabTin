import * as Y from "yjs";

import {
  applyTableRecordOrderPlan,
  LEGACY_RECORD_ORDER_FIELD,
  planTableRecordInsert,
} from "@tabtin/table-engine/collab/table-record-order";
import {
  RECORD_POSITION_FIELD,
  type RecordPositionPlan,
} from "@tabtin/table-engine/collab/record-position";

import { isObject, type CollabPrimitiveOp } from "./types.js";

const TABLE_RECORDS = "records";
const TABLE_ROW_ORDER = "rowOrder";
const TABLE_ROW_ORDER_MAP = "rowOrderMap";

function isPath(path: string[], ...segments: string[]): boolean {
  return path.length === segments.length
    && path.every((segment, index) => segment === segments[index]);
}

function isTableRowOrderPath(path: string[]): boolean {
  return isPath(path, TABLE_ROW_ORDER_MAP);
}

function ensurePlanningMapAtPath(ydoc: Y.Doc, path: string[]): Y.Map<unknown> {
  let current = ydoc.getMap<unknown>(path[0]);
  for (const key of path.slice(1)) {
    const existing = current.get(key);
    if (existing instanceof Y.Map) {
      current = existing;
      continue;
    }
    const nested = new Y.Map<unknown>();
    current.set(key, nested);
    current = nested;
  }
  return current;
}

function replacePlanningArray(ydoc: Y.Doc, path: string[], values: unknown[]): void {
  if (!isPath(path, TABLE_ROW_ORDER)) return;
  const target = ydoc.getArray<unknown>(TABLE_ROW_ORDER);
  if (target.length > 0) target.delete(0, target.length);
  if (values.length > 0) target.insert(0, values);
}

function isPlanningScalar(value: unknown): value is string | number | boolean | null {
  return value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean";
}

function fieldsNeededForDeleteWhere(ops: readonly CollabPrimitiveOp[]): Set<string> {
  const fields = new Set([RECORD_POSITION_FIELD, LEGACY_RECORD_ORDER_FIELD]);
  for (const op of ops) {
    if (op.op === "map.delete_where" && isPath(op.path, TABLE_RECORDS)) {
      for (const fieldId of Object.keys(op.equals)) fields.add(fieldId);
    }
  }
  return fields;
}

function createPlanningDoc(ydoc: Y.Doc, ops: readonly CollabPrimitiveOp[]): Y.Doc {
  const planningDoc = new Y.Doc();
  const planningRecords = planningDoc.getMap<Y.Map<unknown>>(TABLE_RECORDS);
  const fieldsToCopy = fieldsNeededForDeleteWhere(ops);
  ydoc.getMap(TABLE_RECORDS).forEach((value, recordId) => {
    if (!(value instanceof Y.Map)) return;
    const planningRecord = new Y.Map<unknown>();
    for (const fieldId of fieldsToCopy) {
      const fieldValue = value.get(fieldId);
      if (isPlanningScalar(fieldValue)) planningRecord.set(fieldId, fieldValue);
    }
    planningRecords.set(recordId, planningRecord);
  });

  const planningOrderMap = planningDoc.getMap<string | number>(TABLE_ROW_ORDER_MAP);
  ydoc.getMap(TABLE_ROW_ORDER_MAP).forEach((value, recordId) => {
    if (typeof value === "string" || typeof value === "number") {
      planningOrderMap.set(recordId, value);
    }
  });

  const rowOrder = ydoc.getArray<unknown>(TABLE_ROW_ORDER)
    .toArray()
    .filter((recordId): recordId is string => typeof recordId === "string");
  if (rowOrder.length > 0) planningDoc.getArray<string>(TABLE_ROW_ORDER).insert(0, rowOrder);
  const sourceMeta = ydoc.getMap<unknown>("meta");
  const planningMeta = planningDoc.getMap<unknown>("meta");
  for (const key of ["is_truncated", "total_records"] as const) {
    if (sourceMeta.has(key)) planningMeta.set(key, sourceMeta.get(key));
  }
  return planningDoc;
}

function valueMatches(value: unknown, equals: Record<string, unknown>): boolean {
  if (value instanceof Y.Map) {
    return Object.entries(equals).some(([key, expected]) => value.get(key) === expected);
  }
  if (isObject(value)) {
    return Object.entries(equals).some(([key, expected]) => value[key] === expected);
  }
  return false;
}

function simulateRelevantPrimitive(ydoc: Y.Doc, op: CollabPrimitiveOp): void {
  if (op.op === "y.update.apply") {
    Y.applyUpdate(ydoc, Buffer.from(op.update_b64, "base64"));
    return;
  }
  if (!("path" in op)) return;

  switch (op.op) {
    case "map.set":
      ensurePlanningMapAtPath(ydoc, op.path).set(op.key, op.value);
      break;
    case "map.patch": {
      const target = ensurePlanningMapAtPath(ydoc, op.path);
      for (const [key, value] of Object.entries(op.values)) target.set(key, value);
      break;
    }
    case "map.delete":
      ensurePlanningMapAtPath(ydoc, op.path).delete(op.key);
      break;
    case "map.clear":
      ensurePlanningMapAtPath(ydoc, op.path).clear();
      break;
    case "map.delete_where": {
      const target = ensurePlanningMapAtPath(ydoc, op.path);
      const keys: string[] = [];
      target.forEach((value, key) => {
        if (valueMatches(value, op.equals)) keys.push(key);
      });
      for (const key of keys) target.delete(key);
      break;
    }
    case "array.replace":
      replacePlanningArray(ydoc, op.path, op.values);
      break;
    case "order.set": {
      if (!isTableRowOrderPath(op.path)) break;
      const target = ydoc.getMap<unknown>(TABLE_ROW_ORDER_MAP);
      for (const [key, value] of Object.entries(op.positions)) target.set(key, value);
      break;
    }
  }
}

function planOrderAfter(
  ydoc: Y.Doc,
  recordId: string,
  anchorRecordId?: string | null,
): RecordPositionPlan {
  // Preserve the primitive's historical contract: a null or missing anchor
  // inserts at the front. This intentionally differs from TabData UI helpers,
  // where a missing anchor is treated as an append fallback.
  return planTableRecordInsert(
    ydoc,
    recordId,
    anchorRecordId
      ? { anchor_record_id: anchorRecordId, position: "after" }
      : { position: "before" },
  );
}

/**
 * Dry-run every TabData order.after before touching the live Y.Doc.
 *
 * A clone is used because ordering is record-level: explicit PositionIds,
 * __order, rowOrderMap and rowOrder all participate. Multiple reorder intents
 * in one request observe prior planned results, and duplicate legacy bounds are
 * lifted by the table-engine seam instead of reaching fractional-indexing.
 */
export function planTableOrderMutations(
  ydoc: Y.Doc,
  ops: readonly CollabPrimitiveOp[],
): ReadonlyMap<number, RecordPositionPlan> {
  if (!ops.some(op => op.op === "order.after" && isTableRowOrderPath(op.path))) {
    return new Map();
  }

  const planningDoc = createPlanningDoc(ydoc, ops);
  try {
    const plans = new Map<number, RecordPositionPlan>();

    ops.forEach((op, index) => {
      if (op.op !== "order.after" || !isTableRowOrderPath(op.path)) {
        simulateRelevantPrimitive(planningDoc, op);
        return;
      }

      const plan = planOrderAfter(planningDoc, op.key, op.after_key);
      if (!plan.allocations.some(allocation => allocation.recordId === op.key)) {
        throw new Error(`Unable to plan table row order for ${op.key}`);
      }
      applyTableRecordOrderPlan(planningDoc, plan);
      plans.set(index, plan);
    });

    return plans;
  } finally {
    planningDoc.destroy();
  }
}
