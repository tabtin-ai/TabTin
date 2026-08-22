import * as Y from "yjs";
import { computeInsertPositionAfter } from "../lib/y-utils.js";
import {
  planTableOrderMutations,
} from "./table-order-plan.js";
import { applyTableRecordOrderPlan } from "@tabtin/table-engine/collab/table-record-order";
import { MAX_BINARY_BYTES, type ApplyOpsHandlerResult, type CollabPrimitiveOp, type PrimitiveExecutorInput, isObject } from "./types.js";

function assertPath(path: unknown, op: string): asserts path is string[] {
  if (
    !Array.isArray(path)
    || path.length === 0
    || path.some(segment => typeof segment !== "string" || segment.length === 0)
  ) throw new Error(`${op} requires a non-empty string path`);
}

function assertPrimitiveOp(op: unknown): asserts op is CollabPrimitiveOp {
  if (!isObject(op) || typeof op.op !== "string") throw new Error("invalid primitive op");
  switch (op.op) {
    case "y.update.apply":
      if (typeof op.update_b64 !== "string" || op.update_b64.length === 0) throw new Error("y.update.apply requires update_b64");
      if (Buffer.from(op.update_b64, "base64").length > MAX_BINARY_BYTES) throw new Error(`update_b64 exceeds ${MAX_BINARY_BYTES} bytes`);
      return;
    case "xml.fragment.replace":
      if (typeof op.fragment !== "string" || op.fragment.length === 0) throw new Error("xml.fragment.replace requires fragment");
      if (typeof op.update_b64 !== "string" || op.update_b64.length === 0) throw new Error("xml.fragment.replace requires update_b64");
      if (Buffer.from(op.update_b64, "base64").length > MAX_BINARY_BYTES) throw new Error(`update_b64 exceeds ${MAX_BINARY_BYTES} bytes`);
      return;
    case "map.set":
      assertPath(op.path, "map.set");
      if (typeof op.key !== "string") throw new Error("map.set requires path and key");
      return;
    case "map.patch":
      assertPath(op.path, "map.patch");
      if (!isObject(op.values)) throw new Error("map.patch requires path and values");
      return;
    case "map.delete":
      assertPath(op.path, "map.delete");
      if (typeof op.key !== "string") throw new Error("map.delete requires path and key");
      return;
    case "map.clear":
      assertPath(op.path, "map.clear");
      return;
    case "map.delete_where":
      assertPath(op.path, "map.delete_where");
      if (!isObject(op.equals)) throw new Error("map.delete_where requires path and equals");
      return;
    case "array.replace":
      assertPath(op.path, "array.replace");
      if (!Array.isArray(op.values)) throw new Error("array.replace requires path and values");
      return;
    case "order.set":
      assertPath(op.path, "order.set");
      if (!isObject(op.positions)) throw new Error("order.set requires path and positions");
      if (Object.values(op.positions).some(value => typeof value !== "string" && typeof value !== "number")) {
        throw new Error("order.set positions must be strings or numbers");
      }
      return;
    case "order.after":
      assertPath(op.path, "order.after");
      if (typeof op.key !== "string") throw new Error("order.after requires path and key");
      if (
        op.after_key !== undefined
        && op.after_key !== null
        && typeof op.after_key !== "string"
      ) throw new Error("order.after after_key must be a string or null");
      return;
    case "stateless.broadcast":
      if (typeof op.event !== "string" || op.event.length === 0) throw new Error("stateless.broadcast requires event");
      return;
    default:
      throw new Error(`unsupported primitive op: ${(op as { op?: unknown }).op}`);
  }
}

function ensureMapAtPath(ydoc: Y.Doc, path: string[]): Y.Map<unknown> {
  if (path.length === 0) throw new Error("path must not be empty");
  let current = ydoc.getMap<unknown>(path[0]);
  for (const key of path.slice(1)) {
    let next = current.get(key) as Y.Map<unknown> | undefined;
    if (!(next instanceof Y.Map)) {
      next = new Y.Map<unknown>();
      current.set(key, next);
    }
    current = next;
  }
  return current;
}

function ensureArrayAtPath(ydoc: Y.Doc, path: string[]): Y.Array<unknown> {
  if (path.length === 0) throw new Error("path must not be empty");
  if (path.length === 1) return ydoc.getArray<unknown>(path[0]);
  const parent = ensureMapAtPath(ydoc, path.slice(0, -1));
  const key = path[path.length - 1];
  let arr = parent.get(key) as Y.Array<unknown> | undefined;
  if (!(arr instanceof Y.Array)) {
    arr = new Y.Array<unknown>();
    parent.set(key, arr);
  }
  return arr;
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

/** 克隆式替换 XmlFragment：对同源历史快照也正确。 */
export function replaceXmlFragment(ydoc: Y.Doc, fragmentName: string, updateB64: string): void {
  const target = ydoc.getXmlFragment(fragmentName);
  target.delete(0, target.length);
  const tempDoc = new Y.Doc();
  try {
    Y.applyUpdate(tempDoc, Buffer.from(updateB64, "base64"));
    const source = tempDoc.getXmlFragment(fragmentName);
    const nodes: Y.XmlElement[] = [];
    for (let i = 0; i < source.length; i++) {
      const child = source.get(i);
      if (child instanceof Y.XmlElement) nodes.push(child.clone());
    }
    if (nodes.length > 0) target.insert(0, nodes);
  } finally {
    tempDoc.destroy();
  }
}

export function executePrimitiveOps(input: PrimitiveExecutorInput): ApplyOpsHandlerResult {
  // Validate the complete request before any shared type is mutated. Yjs
  // transactions batch observer delivery but do not roll back earlier writes
  // when a later operation throws.
  const ops = input.ops.map((rawOp) => {
    assertPrimitiveOp(rawOp);
    return rawOp;
  });
  const isTableResource = input.resourceType === "table"
    || (input.resourceType == null && input.documentName.startsWith("table:"));
  const plannedTableOrderMutations = isTableResource
    ? planTableOrderMutations(input.ydoc, ops)
    : new Map<number, never>();

  let applied = 0;
  input.ydoc.transact(() => {
    for (let opIndex = 0; opIndex < ops.length; opIndex += 1) {
      const rawOp = ops[opIndex];
      switch (rawOp.op) {
        case "y.update.apply":
          Y.applyUpdate(input.ydoc, Buffer.from(rawOp.update_b64, "base64"), "apply-ops");
          applied++;
          break;
        case "xml.fragment.replace":
          replaceXmlFragment(input.ydoc, rawOp.fragment, rawOp.update_b64);
          applied++;
          break;
        case "map.set":
          ensureMapAtPath(input.ydoc, rawOp.path).set(rawOp.key, rawOp.value);
          applied++;
          break;
        case "map.patch": {
          const target = ensureMapAtPath(input.ydoc, rawOp.path);
          for (const [key, value] of Object.entries(rawOp.values)) target.set(key, value);
          applied++;
          break;
        }
        case "map.delete":
          ensureMapAtPath(input.ydoc, rawOp.path).delete(rawOp.key);
          applied++;
          break;
        case "map.clear":
          ensureMapAtPath(input.ydoc, rawOp.path).clear();
          applied++;
          break;
        case "map.delete_where": {
          const target = ensureMapAtPath(input.ydoc, rawOp.path);
          const keys: string[] = [];
          target.forEach((value, key) => { if (valueMatches(value, rawOp.equals)) keys.push(key); });
          for (const key of keys) target.delete(key);
          applied++;
          break;
        }
        case "array.replace": {
          const target = ensureArrayAtPath(input.ydoc, rawOp.path);
          target.delete(0, target.length);
          if (rawOp.values.length > 0) target.push(rawOp.values);
          applied++;
          break;
        }
        case "order.set": {
          const target = ensureMapAtPath(input.ydoc, rawOp.path);
          for (const [key, value] of Object.entries(rawOp.positions)) target.set(key, value);
          applied++;
          break;
        }
        case "order.after": {
          const plannedMutation = plannedTableOrderMutations.get(opIndex);
          if (plannedMutation) {
            applyTableRecordOrderPlan(input.ydoc, plannedMutation);
          } else {
            const target = ensureMapAtPath(input.ydoc, rawOp.path) as Y.Map<number | string>;
            target.set(rawOp.key, computeInsertPositionAfter(target, rawOp.after_key ?? null));
          }
          applied++;
          break;
        }
        case "stateless.broadcast": {
          const hocusDoc = input.routeContext.resolveHocuspocusInstance(input.documentName).instance.documents.get(input.documentName);
          if (hocusDoc) hocusDoc.broadcastStateless(JSON.stringify({ type: rawOp.event, payload: rawOp.payload }));
          applied++;
          break;
        }
      }
    }
  }, "apply-ops");
  return { applied };
}
