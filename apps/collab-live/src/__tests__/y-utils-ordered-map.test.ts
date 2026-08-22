/**
 * Y.Array → Y.Map 有序 ID 列表迁移工具 — 单元测试
 *
 * 覆盖 getOrderedIds / setOrderedIds / syncArrayToMap 三个函数。
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  computeInsertPositionAfter,
  getOrderedIds,
  setOrderedIds,
  syncArrayToMap,
} from "../lib/y-utils.js";

function makeDoc() {
  return new Y.Doc();
}

// ================================================================
// getOrderedIds
// ================================================================

describe("getOrderedIds", () => {
  it("空 map 返回空数组", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    expect(getOrderedIds(map)).toEqual([]);
  });

  it("按 position 升序返回 ID", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    doc.transact(() => {
      map.set("c", 2);
      map.set("a", 0);
      map.set("b", 1);
    });
    expect(getOrderedIds(map)).toEqual(["a", "b", "c"]);
  });

  it("支持非连续 position（如中间插入）", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    doc.transact(() => {
      map.set("first", 0);
      map.set("last", 2);
      map.set("middle", 1.5);
    });
    expect(getOrderedIds(map)).toEqual(["first", "middle", "last"]);
  });

  it("position 相同时按 key 字典序稳定排序", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    doc.transact(() => {
      map.set("bravo", 1);
      map.set("alpha", 1);
      map.set("charlie", 1);
    });
    expect(getOrderedIds(map)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("支持负数和浮点 position", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    doc.transact(() => {
      map.set("z", -1);
      map.set("a", 0.5);
      map.set("m", 0.25);
    });
    expect(getOrderedIds(map)).toEqual(["z", "m", "a"]);
  });
});

// ================================================================
// setOrderedIds
// ================================================================

describe("setOrderedIds", () => {
  it("向空 map 写入有序列表", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    setOrderedIds(map, ["x", "y", "z"]);
    expect(getOrderedIds(map)).toEqual(["x", "y", "z"]);
    expect(map.get("x")).toBe(0);
    expect(map.get("y")).toBe(1);
    expect(map.get("z")).toBe(2);
  });

  it("覆盖已有内容并清除多余 key", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    doc.transact(() => {
      map.set("old-1", 0);
      map.set("old-2", 1);
      map.set("old-3", 2);
    });

    setOrderedIds(map, ["new-a", "new-b"]);
    expect(getOrderedIds(map)).toEqual(["new-a", "new-b"]);
    expect(map.has("old-1")).toBe(false);
    expect(map.has("old-2")).toBe(false);
    expect(map.has("old-3")).toBe(false);
  });

  it("保留同名 key 并更新 position", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    setOrderedIds(map, ["a", "b", "c"]);
    setOrderedIds(map, ["c", "a"]);
    expect(getOrderedIds(map)).toEqual(["c", "a"]);
    expect(map.get("c")).toBe(0);
    expect(map.get("a")).toBe(1);
    expect(map.has("b")).toBe(false);
  });

  it("空数组清空整个 map", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    setOrderedIds(map, ["a", "b"]);
    setOrderedIds(map, []);
    expect(map.size).toBe(0);
    expect(getOrderedIds(map)).toEqual([]);
  });

  it("操作是原子性的（单 transaction）", () => {
    const doc = makeDoc();
    const map = doc.getMap<number>("order");
    const events: Y.YMapEvent<number>[] = [];
    map.observe((e) => events.push(e));

    setOrderedIds(map, ["a", "b", "c"]);
    expect(events.length).toBe(1);
  });
});

// ================================================================
// computeInsertPositionAfter（锚点口径 ）
// ================================================================

describe("computeInsertPositionAfter", () => {
  it("空 map → 返回 0", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    expect(computeInsertPositionAfter(map, "anything")).toBe(0);
  });

  it("整数 position：插到 anchor 与后继之间取中点", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    doc.transact(() => {
      map.set("a", 0);
      map.set("b", 1);
      map.set("c", 2);
    });
    const pos = computeInsertPositionAfter(map, "a");
    map.set("new", pos);
    expect(getOrderedIds(map)).toEqual(["a", "new", "b", "c"]);
  });

  it("anchor 为末尾 → 排到最后（anchor+1）", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    doc.transact(() => {
      map.set("a", 0);
      map.set("b", 1);
    });
    const pos = computeInsertPositionAfter(map, "b");
    map.set("new", pos);
    expect(getOrderedIds(map)).toEqual(["a", "b", "new"]);
  });

  it("anchor 为空 / 不存在 → 插到最前", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    doc.transact(() => {
      map.set("a", 0);
      map.set("b", 1);
    });
    const posNull = computeInsertPositionAfter(map, null);
    map.set("front", posNull);
    expect(getOrderedIds(map)[0]).toBe("front");

    const posMissing = computeInsertPositionAfter(map, "nonexistent");
    map.set("front2", posMissing);
    expect(getOrderedIds(map)[0]).toBe("front2");
  });

  it("fractional string position：generateKeyBetween 插到 anchor 之后", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    setOrderedIds(map, ["a", "b", "c"]); // 写入 fractional 字符串 position
    const pos = computeInsertPositionAfter(map, "a");
    expect(typeof pos).toBe("string");
    map.set("new", pos);
    expect(getOrderedIds(map)).toEqual(["a", "new", "b", "c"]);
  });

  it("fractional string + anchor 末尾 → 排到最后", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    setOrderedIds(map, ["a", "b"]);
    const pos = computeInsertPositionAfter(map, "b");
    map.set("new", pos);
    expect(getOrderedIds(map)).toEqual(["a", "b", "new"]);
  });

  it("连续插入多个新记录到同一 anchor 之后，顺序稳定", () => {
    const doc = makeDoc();
    const map = doc.getMap<number | string>("order");
    doc.transact(() => {
      map.set("parent", 0);
      map.set("tail", 1);
    });
    // 模拟 child1、child2 依次插到 parent 之后（child2 的 anchor 是 child1）
    map.set("child1", computeInsertPositionAfter(map, "parent"));
    map.set("child2", computeInsertPositionAfter(map, "child1"));
    expect(getOrderedIds(map)).toEqual(["parent", "child1", "child2", "tail"]);
  });
});

// ================================================================
// syncArrayToMap
// ================================================================

describe("syncArrayToMap", () => {
  it("Y.Array 非空 + Y.Map 空 → 同步", () => {
    const doc = makeDoc();
    const arr = doc.getArray<string>("pageOrder");
    const map = doc.getMap<number>("pageOrderMap");

    doc.transact(() => arr.push(["p1", "p2", "p3"]));
    syncArrayToMap(arr, map);

    expect(getOrderedIds(map)).toEqual(["p1", "p2", "p3"]);
  });

  it("Y.Map 已有数据 → 不覆盖", () => {
    const doc = makeDoc();
    const arr = doc.getArray<string>("pageOrder");
    const map = doc.getMap<number>("pageOrderMap");

    doc.transact(() => {
      arr.push(["old-1", "old-2"]);
      map.set("existing", 0);
    });
    syncArrayToMap(arr, map);

    expect(map.size).toBe(1);
    expect(map.has("existing")).toBe(true);
    expect(map.has("old-1")).toBe(false);
  });

  it("Y.Array 空 → 不操作", () => {
    const doc = makeDoc();
    const arr = doc.getArray<string>("empty");
    const map = doc.getMap<number>("emptyMap");

    syncArrayToMap(arr, map);
    expect(map.size).toBe(0);
  });

  it("两者都空 → 无变化", () => {
    const doc = makeDoc();
    const arr = doc.getArray<string>("a");
    const map = doc.getMap<number>("m");
    syncArrayToMap(arr, map);
    expect(map.size).toBe(0);
    expect(arr.length).toBe(0);
  });

  it("处理重复 ID：Y.Array 有重复时去重取最后位置", () => {
    const doc = makeDoc();
    const arr = doc.getArray<string>("order");
    const map = doc.getMap<number>("orderMap");

    doc.transact(() => arr.push(["a", "b", "a", "c"]));
    syncArrayToMap(arr, map);

    expect(map.size).toBe(3);
    expect(map.get("a")).toBe(2);
    expect(map.get("b")).toBe(1);
    expect(map.get("c")).toBe(3);
  });
});

// ================================================================
// 集成场景：模拟 CRDT 并发合并
// ================================================================

describe("CRDT 并发场景", () => {
  it("两个客户端同时 set 同一 key → LWW 不翻倍", () => {
    const doc1 = makeDoc();
    const doc2 = makeDoc();
    const map1 = doc1.getMap<number>("order");
    const map2 = doc2.getMap<number>("order");

    setOrderedIds(map1, ["page-1", "page-2"]);
    setOrderedIds(map2, ["page-1", "page-2", "page-3"]);

    const state1 = Y.encodeStateAsUpdate(doc1);
    const state2 = Y.encodeStateAsUpdate(doc2);

    Y.applyUpdate(doc1, state2);
    Y.applyUpdate(doc2, state1);

    const ids1 = getOrderedIds(map1);
    const ids2 = getOrderedIds(map2);

    expect(ids1).toEqual(ids2);
    expect(new Set(ids1).size).toBe(ids1.length);
  });

  it("并发 delete + set 不会出现幽灵 key", () => {
    const doc1 = makeDoc();
    const doc2 = makeDoc();

    const map1 = doc1.getMap<number>("order");
    setOrderedIds(map1, ["a", "b", "c"]);
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const map2 = doc2.getMap<number>("order");

    doc1.transact(() => map1.delete("b"));
    doc2.transact(() => map2.set("b", 1));

    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2));
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1));

    const ids1 = getOrderedIds(map1);
    const ids2 = getOrderedIds(map2);
    expect(ids1).toEqual(ids2);
  });

  it("syncArrayToMap 幂等性：多次调用结果一致", () => {
    const doc = makeDoc();
    const arr = doc.getArray<string>("arr");
    const map = doc.getMap<number>("map");

    doc.transact(() => arr.push(["x", "y", "z"]));

    syncArrayToMap(arr, map);
    const first = getOrderedIds(map);

    syncArrayToMap(arr, map);
    const second = getOrderedIds(map);

    expect(first).toEqual(second);
    expect(first).toEqual(["x", "y", "z"]);
  });
});
