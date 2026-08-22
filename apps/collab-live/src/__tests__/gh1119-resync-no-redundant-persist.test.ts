/**
 *  回归测试：resync 后不产生冗余 persist（消除还原噪音）。
 *
 * 还原噪音的根因是「force-close → 客户端重连 → Y.Doc 快照 merge → collab 回写」，
 * 给每条顺序/内容变化的记录写一条无 operation_group_id 的 system `update`（如 `_order`），
 * Electron 时间线每条各成一个条目。
 *
 * resync 路径不 force-close、并在应用还原 delta 后把持久化基线重置为还原后快照
 * （resyncLoadedDocument → onSnapshotLoaded → TableDatabase.saveSnapshot）。本测试验证
 * 该机制：resync 后 live 文档已是还原态，且紧随的 buildPersistPayload 返回 null —— 不落库、
 * 不产生 `_order`/system 噪音历史。
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as Y from "yjs";
import { TableDatabase, clearTableSnapshot } from "../extensions/table-database.js";
import { computeResyncDelta, RESYNC_ORIGIN } from "../lib/resync.js";
import { getOrderedIds } from "../lib/y-utils.js";

interface TableSnapshotInput {
  records: Record<string, Record<string, unknown>>;
  row_order: string[];
  fields: unknown[];
  table_version: number;
  table_name: string;
  table_id: string;
}

function makeSnapshot(
  records: Record<string, Record<string, unknown>>,
  rowOrder: string[],
): TableSnapshotInput {
  return {
    records,
    row_order: rowOrder,
    fields: [{ id: "f0" }],
    table_version: 1,
    table_name: "T",
    table_id: "tbl-1",
  };
}

function readOrder(doc: Y.Doc): string[] {
  return getOrderedIds(doc.getMap("rowOrderMap"));
}

let seq = 7000;
function freshDoc(): Y.Doc {
  const d = new Y.Doc();
  d.clientID = ++seq;
  return d;
}

/** 用 db.applySnapshotToDoc 在一个新 Y.Doc 上构建表格态。 */
function buildDocFromSnapshot(db: TableDatabase, snapshot: TableSnapshotInput): Y.Doc {
  const doc = freshDoc();
  doc.transact(() => {
    (db as unknown as { applySnapshotToDoc(d: Y.Doc, s: Record<string, unknown>): void })
      .applySnapshotToDoc(doc, snapshot as unknown as Record<string, unknown>);
  });
  return doc;
}

describe(" resync 后不产生冗余 persist", () => {
  let db: TableDatabase;
  const docName = "table:resync-noise";

  beforeAll(() => {
    db = new TableDatabase();
  });

  function buildPersist(doc: Y.Doc) {
    return (db as unknown as {
      buildPersistPayload(d: Y.Doc, name: string, ctx: Record<string, unknown>): unknown | null;
    }).buildPersistPayload(doc, docName, {});
  }
  function saveSnapshot(doc: Y.Doc) {
    (db as unknown as { saveSnapshot(name: string, d: Y.Doc): void }).saveSnapshot(docName, doc);
  }

  it("还原仅改变行序：resync 后 buildPersistPayload 为 null（无 _order 噪音回写）", () => {
    clearTableSnapshot(docName);
    // 还原前在线态：order [r1,r2,r3]
    const live = buildDocFromSnapshot(db, makeSnapshot(
      { r1: { f0: "a" }, r2: { f0: "b" }, r3: { f0: "c" } },
      ["r1", "r2", "r3"],
    ));
    saveSnapshot(live);
    expect(buildPersist(live)).toBeNull(); // 基线对齐，无变更

    // 还原目标：行序变为 [r3,r1,r2]（内容不变）——这是产生 `_order` 噪音的典型场景
    const target = buildDocFromSnapshot(db, makeSnapshot(
      { r1: { f0: "a" }, r2: { f0: "b" }, r3: { f0: "c" } },
      ["r3", "r1", "r2"],
    ));

    // 模拟 resyncLoadedDocument：应用 delta + 重置基线
    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target));
    Y.applyUpdate(live, delta, RESYNC_ORIGIN);
    saveSnapshot(target); // = onSnapshotLoaded(target)

    // live 已是还原后的行序
    expect(readOrder(live)).toEqual(["r3", "r1", "r2"]);
    // 关键：紧随的 persist 为空 → 不写回 → 无 `_order`/system 噪音历史
    expect(buildPersist(live)).toBeNull();

    live.destroy();
    target.destroy();
  });

  it("还原改变记录内容+删行：resync 后 buildPersistPayload 为 null", () => {
    clearTableSnapshot(docName);
    const live = buildDocFromSnapshot(db, makeSnapshot(
      { r1: { f0: "a" }, r2: { f0: "b" }, r3: { f0: "c" } },
      ["r1", "r2", "r3"],
    ));
    saveSnapshot(live);

    // 还原目标：删 r2、改 r1
    const target = buildDocFromSnapshot(db, makeSnapshot(
      { r1: { f0: "a-restored" }, r3: { f0: "c" } },
      ["r1", "r3"],
    ));

    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target));
    Y.applyUpdate(live, delta, RESYNC_ORIGIN);
    saveSnapshot(target);

    expect(readOrder(live)).toEqual(["r1", "r3"]);
    const records = live.getMap("records");
    expect([...records.keys()].sort()).toEqual(["r1", "r3"]);
    expect(buildPersist(live)).toBeNull();

    live.destroy();
    target.destroy();
  });
});
