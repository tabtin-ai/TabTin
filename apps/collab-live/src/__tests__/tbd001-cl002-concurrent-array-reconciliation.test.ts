/**
 * 回归测试 — TBD-001 / CL-002
 *
 * TBD-001 (P0): _fetchDocument 的 prepareYDocForMerge 清空 Y.Array 时，
 *   会连带删除存在于 preFetchState 但不在 Django 快照中的并发/未持久化新增条目。
 * CL-002 (P1): 与 TBD-001 同一根因，从 collab 基础设施视角描述。
 *
 * 验证修复后：
 *   1. 未持久化的 Y.Array 条目（如新增行/页面）在 fetch 后得以保留
 *   2. Django 的权威数据正确加载
 *   3. Django 有但 preFetchState 没有的新条目也正确加载
 *   4. fetch 期间到达的并发编辑仍然保留（既有行为不退化）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";
import { getOrderedIds } from "../lib/y-utils.js";

// ── mocks ──────────────────────────────────────────

vi.mock("../env.js", () => ({
  env: {
    DJANGO_API_URL: "http://localhost:6060",
    LIVE_SECRET: "test-secret",
    SERVER_NAME: "test-server",
  },
}));

vi.mock("../extensions/metrics.js", () => ({
  metrics: {
    increment: vi.fn(),
    recordStoreLatency: vi.fn(),
    storeErrors: 0,
    fetchErrors: 0,
    snapshotCacheSizes: {} as Record<string, number>,
  },
}));

vi.mock("../services/django-api.js", () => ({
  fetchCollabSnapshot: vi.fn(),
  persistCollabChanges: vi.fn(),
}));

vi.mock("../lib/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock("../lib/collab-utils.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    handleStoreError: vi.fn(async ({ error }: { error: unknown }) => {
      throw error;
    }),
  };
});

// ══════════════════════════════════════════════════
// TBD-001: 未持久化的 rowOrder 条目在 fetch 后保留
// ══════════════════════════════════════════════════

describe("TBD-001: unpersisted rowOrder items survive fetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetch preserves rowOrder items not in Django snapshot (table)", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "v1" }, r2: { f1: "v2" } },
      row_order: ["r1", "r2"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r1", "r2", "r_unpersisted"]);
      const records = ydoc.getMap("records");
      for (const id of ["r1", "r2", "r_unpersisted"]) {
        const rec = new Y.Map<unknown>();
        rec.set("f1", `local_${id}`);
        records.set(id, rec);
      }
    });

    const result = await (db as any)._fetchDocument({
      documentName: "table:tbd001-test",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    Y.applyUpdate(ydoc, result);

    const rowOrder = ydoc.getArray<string>("rowOrder");
    const rowOrderArr = rowOrder.toArray();

    expect(rowOrderArr).toContain("r1");
    expect(rowOrderArr).toContain("r2");
    expect(rowOrderArr).toContain("r_unpersisted");

    ydoc.destroy();
  });

  it("fetch also loads Django-only items (e.g., agent SQL additions)", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: {
        r1: { f1: "v1" },
        r2: { f1: "v2" },
        r_agent: { f1: "agent_added" },
      },
      row_order: ["r1", "r2", "r_agent"],
      fields: [],
      table_version: 2,
      table_name: "Test",
      table_id: "tid",
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r1", "r2", "r_local"]);
      const records = ydoc.getMap("records");
      for (const id of ["r1", "r2", "r_local"]) {
        const rec = new Y.Map<unknown>();
        rec.set("f1", `local_${id}`);
        records.set(id, rec);
      }
    });

    const result = await (db as any)._fetchDocument({
      documentName: "table:tbd001-agent",
      document: ydoc,
      context: {},
    });

    Y.applyUpdate(ydoc, result);

    // step4: rowOrderMap（Y.Map）是主数据源，包含 Django 数据 + 并发条目
    const rom = ydoc.getMap<number>("rowOrderMap");
    const orderedIds = getOrderedIds(rom);
    expect(orderedIds).toContain("r1");
    expect(orderedIds).toContain("r2");
    expect(orderedIds).toContain("r_agent");
    expect(orderedIds).toContain("r_local");

    ydoc.destroy();
  });

  it("fetch with no concurrent additions works normally", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "v1" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r1"]);
      const records = ydoc.getMap("records");
      const rec = new Y.Map<unknown>();
      rec.set("f1", "local");
      records.set("r1", rec);
    });

    const result = await (db as any)._fetchDocument({
      documentName: "table:tbd001-normal",
      document: ydoc,
      context: {},
    });

    Y.applyUpdate(ydoc, result);
    const rowOrder = ydoc.getArray<string>("rowOrder").toArray();
    expect(rowOrder).toEqual(["r1"]);

    ydoc.destroy();
  });

  it("fetching a fresher Django snapshot does not persist stale existing records", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: {
        r1: { f1: "server_latest" },
        r2: { f1: "server_stable" },
      },
      row_order: ["r1", "r2"],
      fields: [{ id: "f1", id_hex: "f1", name: "Name", field_type: "text" }],
      table_version: 7,
      table_name: "Test",
      table_id: "tid",
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const records = ydoc.getMap("records");
      const r1 = new Y.Map<unknown>();
      r1.set("f1", "stale_local");
      records.set("r1", r1);
      const r2 = new Y.Map<unknown>();
      r2.set("f1", "server_stable");
      records.set("r2", r2);
      ydoc.getMap<number>("rowOrderMap").set("r1", 0);
      ydoc.getMap<number>("rowOrderMap").set("r2", 1);
    });

    const result = await (db as any)._fetchDocument({
      documentName: "table:tbd001-stale-existing",
      document: ydoc,
      context: {},
    });

    Y.applyUpdate(ydoc, result);

    const r1 = ydoc.getMap("records").get("r1") as Y.Map<unknown>;
    expect(r1.get("f1")).toBe("server_latest");
    expect((db as any).buildPersistPayload(ydoc, "table:tbd001-stale-existing", {})).toBeNull();

    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════════
// CL-002: 跨模块验证 — Slide pageOrder 同样受保护
// ══════════════════════════════════════════════════

describe("CL-002: unpersisted pageOrder items survive fetch (slide)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetch preserves pageOrder items not in Django snapshot (slide)", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { SlideDatabase, clearSlideSnapshot } = await import(
      "../extensions/slide-database.js"
    );

    const serverSnapshot = {
      pages: [
        { id: "p1", elements: [{ id: "e1", type: "text", content: "hello" }] },
      ],
      page_order: ["p1"],
      version: 1,
      project_name: "Test",
      project_id: "pid",
      canvas_width: 1920,
      canvas_height: 1080,
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new SlideDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const pageOrder = ydoc.getArray<string>("pageOrder");
      pageOrder.push(["p1", "p_local"]);
      const pagesMap = ydoc.getMap("pages");

      const p1 = new Y.Map<unknown>();
      p1.set("elementOrder", new Y.Array<string>());
      p1.set("elementsMap", new Y.Map());
      pagesMap.set("p1", p1);

      const pLocal = new Y.Map<unknown>();
      pLocal.set("elementOrder", new Y.Array<string>());
      pLocal.set("elementsMap", new Y.Map());
      pagesMap.set("p_local", pLocal);
    });

    const result = await (db as any)._fetchDocument({
      documentName: "slide:cl002-test",
      document: ydoc,
      context: {},
    });

    Y.applyUpdate(ydoc, result);
    const pageOrder = ydoc.getArray<string>("pageOrder").toArray();

    expect(pageOrder).toContain("p1");
    expect(pageOrder).toContain("p_local");

    clearSlideSnapshot("slide:cl002-test");
    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════════
// 边界情况：空文档、无 prepareYDocForMerge、重复条目
// ══════════════════════════════════════════════════

describe("TBD-001/CL-002: edge cases", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("step4: fetch on empty ydoc populates Y.Map with Django data", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "v1" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    const result = await (db as any)._fetchDocument({
      documentName: "table:tbd001-empty",
      document: ydoc,
      context: {},
    });

    Y.applyUpdate(ydoc, result);

    // step4: Y.Map 是主数据源，包含 Django 数据
    const rom = ydoc.getMap<number>("rowOrderMap");
    expect(getOrderedIds(rom)).toEqual(["r1"]);

    ydoc.destroy();
  });

  it("duplicate items in preFetchState are not re-added multiple times", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "v1" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
    };
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(serverSnapshot);

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r1", "r_dup", "r_dup"]);
    });

    const result = await (db as any)._fetchDocument({
      documentName: "table:tbd001-dup",
      document: ydoc,
      context: {},
    });

    Y.applyUpdate(ydoc, result);
    const rowOrder = ydoc.getArray<string>("rowOrder").toArray();

    const dupCount = rowOrder.filter((id: string) => id === "r_dup").length;
    expect(dupCount).toBe(1);

    ydoc.destroy();
  });

  it("step4: concurrent edits during fetch are still preserved (regression)", async () => {
    const { fetchCollabSnapshot } = await import("../services/django-api.js");
    const { TableDatabase } = await import("../extensions/table-database.js");

    const serverSnapshot = {
      records: { r1: { f1: "server" } },
      row_order: ["r1"],
      fields: [],
      table_version: 1,
      table_name: "Test",
      table_id: "tid",
    };

    let resolveFetch!: (v: unknown) => void;
    (fetchCollabSnapshot as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolveFetch = resolve; }),
    );

    const db = new TableDatabase();
    const ydoc = new Y.Doc();

    ydoc.transact(() => {
      const rowOrder = ydoc.getArray<string>("rowOrder");
      rowOrder.push(["r_pre"]);
    });

    const fetchPromise = (db as any)._fetchDocument({
      documentName: "table:tbd001-concurrent",
      document: ydoc,
      context: {},
    });

    ydoc.transact(() => {
      const records = ydoc.getMap("records");
      const newR = new Y.Map<unknown>();
      newR.set("f1", "during_fetch");
      records.set("r_during", newR);
      ydoc.getArray<string>("rowOrder").push(["r_during"]);
    });

    resolveFetch(serverSnapshot);
    const result = await fetchPromise;
    Y.applyUpdate(ydoc, result);

    const records = ydoc.getMap("records");
    expect(records.get("r_during")).toBeDefined();

    // step4: rowOrderMap（Y.Map）包含 Django 数据（r1）
    // r_during 是在 fetch 期间写入 ydoc.rowOrder Y.Array 的，
    // 它不在 preFetchDoc 中，因此 _reconcileConcurrentArrayItems 不会恢复它到 mergeDoc，
    // reconcileConcurrentItems 也不会把它同步到 rowOrderMap。
    // r_during 保留在 ydoc.rowOrder Y.Array 中（CRDT 不会删除它），
    // 但 rowOrderMap 只包含 Django 数据。
    // 这是 step4 已知限制：fetch 期间直接写入 Y.Array 的并发条目不会自动同步到 Y.Map。
    const rom = ydoc.getMap<number>("rowOrderMap");
    const orderedIds = getOrderedIds(rom);
    expect(orderedIds).toContain("r1");

    // r_during 保留在 rowOrder Y.Array 中（CRDT 保留）
    const rowOrderArr = ydoc.getArray<string>("rowOrder");
    const rowOrderIds = rowOrderArr.toArray();
    expect(rowOrderIds).toContain("r_during");

    ydoc.destroy();
  });
});
