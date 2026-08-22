/**
 * Y.js 通用工具函数
 */
import * as Y from "yjs";
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

function toPlain(value: unknown): unknown {
  if (value instanceof Y.Map) return yMapToPlain(value);
  if (value instanceof Y.Array) return value.toArray().map(toPlain);
  if (value instanceof Y.Text) return value.toString();
  return value;
}

export function yMapToPlain(ymap: Y.Map<unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  ymap.forEach((value: unknown, key: string) => {
    obj[key] = toPlain(value);
  });
  return obj;
}

// ─── Y.Map<string, string> 有序 ID 工具（Fractional Indexing） ───

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 兼容 Y.Map<number> / Y.Map<string> / Y.Map<number|string> 的调用方
type OrderMap = Y.Map<any>;

/**
 * 从 Y.Map 中读取按 position 排序的 ID 列表。
 * 向后兼容：支持 number（旧格式）和 string（新 fractional index 格式）混合排序。
 */
export function getOrderedIds(ymap: OrderMap): string[] {
  const entries: [string, number | string][] = [];
  ymap.forEach((pos: number | string, id: string) => entries.push([id, pos]));
  entries.sort((a, b) => {
    const pa = a[1], pb = b[1];
    const ta = typeof pa, tb = typeof pb;
    if (ta === "number" && tb === "number") return (pa as number) - (pb as number) || a[0].localeCompare(b[0]);
    if (ta === "string" && tb === "string") return pa < pb ? -1 : pa > pb ? 1 : a[0].localeCompare(b[0]);
    return ta === "number" ? -1 : 1;
  });
  return entries.map(([id]) => id);
}

/**
 * 计算把新记录插到 anchorId 之后所需的 position（不修改 ymap）。
 *
 * 锚点口径：新记录的相对位置由后端 ``__order`` 决定，协作层只需把它插到
 * 「``__order`` 前驱」之后即可——position 数值本身不必等于 ``__order``，只要排序后
 * 落在 anchor 与其后继之间，协作行序就跟随 ``__order``，不再一律 ``maxPos+1`` 沉底。
 *
 * - ``anchorId`` 为空 / 不在 map 中 → 插到最前。
 * - 兼容 number（旧整数 position）与 string（fractional index）混合：
 *   - anchor 为 number：与后继 number 取中点；后继缺失或为 string 时 ``anchor+1``。
 *   - anchor 为 string：``generateKeyBetween(anchor, 后继 string | null)``。
 * - map 为空 → 返回 0（与既有 ``maxPos+1`` 起点一致）。
 */
export function computeInsertPositionAfter(
  ymap: OrderMap,
  anchorId: string | null | undefined,
): number | string {
  const entries: [string, number | string][] = [];
  ymap.forEach((pos: number | string, id: string) => entries.push([id, pos]));
  if (entries.length === 0) return 0;
  entries.sort((a, b) => {
    const pa = a[1], pb = b[1];
    const ta = typeof pa, tb = typeof pb;
    if (ta === "number" && tb === "number") return (pa as number) - (pb as number) || a[0].localeCompare(b[0]);
    if (ta === "string" && tb === "string") return pa < pb ? -1 : pa > pb ? 1 : a[0].localeCompare(b[0]);
    return ta === "number" ? -1 : 1;
  });

  let anchorIdx = -1;
  if (anchorId) {
    anchorIdx = entries.findIndex(([id]) => id === anchorId);
  }

  if (anchorIdx === -1) {
    const firstPos = entries[0][1];
    if (typeof firstPos === "number") return firstPos - 1;
    return generateKeyBetween(null, firstPos as string);
  }

  const anchorPos = entries[anchorIdx][1];
  const nextPos = anchorIdx + 1 < entries.length ? entries[anchorIdx + 1][1] : undefined;

  if (typeof anchorPos === "number") {
    if (typeof nextPos === "number") return (anchorPos + nextPos) / 2;
    return anchorPos + 1;
  }
  const nextKey = typeof nextPos === "string" ? nextPos : null;
  return generateKeyBetween(anchorPos as string, nextKey);
}

/**
 * 将有序 ID 列表写入 Y.Map，使用 fractional index 字符串作为 position。
 */
export function setOrderedIds(ymap: OrderMap, ids: string[]): void {
  const doc = ymap.doc;
  const apply = () => {
    const idSet = new Set(ids);
    const keysToDelete: string[] = [];
    ymap.forEach((_: unknown, key: string) => {
      if (!idSet.has(key)) keysToDelete.push(key);
    });
    for (const key of keysToDelete) ymap.delete(key);
    const positions = ids.length > 0 ? generateNKeysBetween(null, null, ids.length) : [];
    for (let i = 0; i < ids.length; i++) {
      ymap.set(ids[i], positions[i]);
    }
  };
  if (doc) {
    doc.transact(apply);
  } else {
    apply();
  }
}

/**
 * 向后兼容：从 Y.Array<string> 同步内容到 Y.Map（使用 fractional index）。
 * 仅当 Y.Map 为空且 Y.Array 非空时执行同步（避免覆盖已有数据）。
 */
export function syncArrayToMap(arr: Y.Array<string>, map: OrderMap): void {
  if (map.size > 0 || arr.length === 0) return;
  const ids = arr.toArray();
  const doc = map.doc;
  const apply = () => {
    const positions = ids.length > 0 ? generateNKeysBetween(null, null, ids.length) : [];
    for (let i = 0; i < ids.length; i++) {
      map.set(ids[i], positions[i]);
    }
  };
  if (doc) {
    doc.transact(apply);
  } else {
    apply();
  }
}
