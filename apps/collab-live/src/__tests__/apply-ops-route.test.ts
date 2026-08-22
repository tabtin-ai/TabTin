import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { executePrimitiveOps } from "../apply-ops/executor.js";
import { TableDatabase, clearTableSnapshot } from "../extensions/table-database.js";
import { broadcastTableOrigin, setupApplyOpsRoutes, validateApplyOpsBody } from "../routes/apply-ops.js";

const routeContext = {
  resolveHocuspocusInstance: () => ({ instance: { documents: new Map() }, documentName: "docs:1" }),
} as any;

describe("validateApplyOpsBody", () => {
  it("accepts a well-formed primitive command request", () => {
    expect(validateApplyOpsBody({
      resource_type: "table",
      document_name: "table:example",
      op_id: "op-1",
      ops: [{ op: "map.patch", path: ["records", "r1"], values: { f1: "v1" } }],
    })).toEqual({ ok: true });
  });

  it("rejects missing or invalid command fields", () => {
    expect(validateApplyOpsBody({ resource_type: "unknown" as never })).toEqual({
      ok: false,
      message: "resource_type must be one of docs/table/slide/video/canvas",
    });
    expect(validateApplyOpsBody({ resource_type: "docs", op_id: "op-1", ops: [{}] })).toEqual({ ok: false, message: "document_name is required" });
    expect(validateApplyOpsBody({ resource_type: "docs", document_name: "table:1", op_id: "op-1", ops: [{}] })).toEqual({ ok: false, message: "document_name must match resource_type prefix" });
    expect(validateApplyOpsBody({ resource_type: "docs", document_name: "docs:1", ops: [{}] })).toEqual({ ok: false, message: "op_id is required" });
    expect(validateApplyOpsBody({ resource_type: "docs", document_name: "docs:1", op_id: "op-1", ops: [] })).toEqual({ ok: false, message: "ops must be a non-empty array" });
  });

  it("requires a strict trusted table request for lifecycle revalidation", () => {
    const base = {
      resource_type: "table",
      document_name: "table:example",
      op_id: "repair-1",
      ops: [{ op: "map.set", path: ["meta"], key: "probe", value: "1" }],
      record_lifecycle_revalidation_ids: ["11111111-1111-1111-1111-111111111111"],
    };

    expect(validateApplyOpsBody({ ...base, require_store_success: "true" as never })).toEqual({
      ok: false,
      message: "require_store_success must be a boolean",
    });
    expect(validateApplyOpsBody({ ...base, require_store_success: true })).toEqual({
      ok: false,
      message: "record_lifecycle_revalidation_ids requires system_policy=trusted_internal",
    });
    expect(validateApplyOpsBody({
      ...base,
      require_store_success: true,
      system_policy: "trusted_internal",
    })).toEqual({ ok: true });
  });
});

describe("setupApplyOpsRoutes", () => {
  it("broadcasts table origin before applying ops", () => {
    const broadcastStateless = vi.fn();
    const instance = { documents: new Map([["table:1", { broadcastStateless }]]) };

    broadcastTableOrigin(instance, "table:1", {
      resource_type: "table",
      document_name: "table:1",
      op_id: "op-1",
      origin_id: "user-1",
      ops: [{ op: "map.patch", path: ["records", "r1"], values: { f1: "v1" } }],
    });

    expect(broadcastStateless).toHaveBeenCalledTimes(1);
    expect(JSON.parse(broadcastStateless.mock.calls[0][0])).toEqual({
      type: "table.cells.pushed",
      payload: { origin_id: "user-1" },
    });
  });

  it("does not broadcast origin for non-table resources", () => {
    const broadcastStateless = vi.fn();
    const instance = { documents: new Map([["docs:1", { broadcastStateless }]]) };

    broadcastTableOrigin(instance, "docs:1", {
      resource_type: "docs",
      document_name: "docs:1",
      op_id: "op-1",
      origin_id: "user-1",
      ops: [{ op: "map.set", path: ["meta"], key: "title", value: "Doc" }],
    });

    expect(broadcastStateless).not.toHaveBeenCalled();
  });

  it("broadcasts table origin before the route applies Y.Doc ops", async () => {
    let routeHandler: ((req: any, res: any) => Promise<void>) | null = null;
    const calls: string[] = [];
    const ydoc = new Y.Doc();
    const instance = {
      documents: new Map([["table:1", {
        broadcastStateless: () => { calls.push("broadcast"); },
      }]]),
      openDirectConnection: async () => ({
        transact: (fn: (doc: Y.Doc) => void) => {
          calls.push("transact");
          fn(ydoc);
        },
        disconnect: async () => {},
      }),
    };
    const ctx = {
      app: {
        post: vi.fn((_path: string, _middleware: unknown, handler: typeof routeHandler) => {
          routeHandler = handler;
        }),
      },
      requireLiveSecret: vi.fn(),
      resolveHocuspocusInstance: () => ({ instance, documentName: "table:1" }),
    } as any;

    setupApplyOpsRoutes(ctx);
    await routeHandler!({
      body: {
        resource_type: "table",
        document_name: "table:1",
        op_id: "op-1",
        origin_id: "user-1",
        ops: [{ op: "map.patch", path: ["records", "r1"], values: { f1: "v1" } }],
      },
    }, { status: vi.fn(function (this: any) { return this; }), json: vi.fn() });

    expect(calls).toEqual(["broadcast", "transact"]);
    expect((ydoc.getMap("records").get("r1") as Y.Map<unknown>).get("f1")).toBe("v1");
  });

  it("continues applying table ops when origin broadcast fails", async () => {
    let routeHandler: ((req: any, res: any) => Promise<void>) | null = null;
    const ydoc = new Y.Doc();
    const instance = {
      documents: new Map([["table:1", {
        broadcastStateless: () => { throw new Error("broadcast failed"); },
      }]]),
      openDirectConnection: async () => ({
        transact: (fn: (doc: Y.Doc) => void) => fn(ydoc),
        disconnect: async () => {},
      }),
    };
    const response = { status: vi.fn(function (this: any) { return this; }), json: vi.fn() };
    const ctx = {
      app: {
        post: vi.fn((_path: string, _middleware: unknown, handler: typeof routeHandler) => {
          routeHandler = handler;
        }),
      },
      requireLiveSecret: vi.fn(),
      resolveHocuspocusInstance: () => ({ instance, documentName: "table:1" }),
    } as any;

    setupApplyOpsRoutes(ctx);
    await routeHandler!({
      body: {
        resource_type: "table",
        document_name: "table:1",
        op_id: "op-1",
        origin_id: "user-1",
        ops: [{ op: "map.patch", path: ["records", "r1"], values: { f1: "v1" } }],
      },
    }, response);

    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
    expect((ydoc.getMap("records").get("r1") as Y.Map<unknown>).get("f1")).toBe("v1");
  });

  it("serializes concurrent apply-ops requests for the same document", async () => {
    let routeHandler: ((req: any, res: any) => Promise<void>) | null = null;
    const app = {
      post: vi.fn((_path: string, _middleware: unknown, handler: typeof routeHandler) => {
        routeHandler = handler;
      }),
    };
    const ydoc = new Y.Doc();
    let activeConnections = 0;
    let maxActiveConnections = 0;

    const instance = {
      documents: new Map(),
      openDirectConnection: async () => {
        activeConnections++;
        maxActiveConnections = Math.max(maxActiveConnections, activeConnections);
        await new Promise(resolve => setTimeout(resolve, 5));
        return {
          transact: (fn: (doc: Y.Doc) => void) => fn(ydoc),
          disconnect: async () => {
            activeConnections--;
          },
        };
      },
    };
    const ctx = {
      app,
      requireLiveSecret: vi.fn(),
      resolveHocuspocusInstance: () => ({ instance, documentName: "table:1" }),
    } as any;

    setupApplyOpsRoutes(ctx);
    expect(routeHandler).not.toBeNull();

    const makeResponse = () => ({
      status: vi.fn(function (this: any) { return this; }),
      json: vi.fn(),
    });
    const request = (opId: string, value: string) => ({
      body: {
        resource_type: "table",
        document_name: "table:1",
        op_id: opId,
        ops: [{ op: "map.patch", path: ["records", "r1"], values: { f1: value } }],
      },
    });

    await Promise.all([
      routeHandler!(request("op-1", "v1"), makeResponse()),
      routeHandler!(request("op-2", "v2"), makeResponse()),
    ]);

    expect(maxActiveConnections).toBe(1);
    expect((ydoc.getMap("records").get("r1") as Y.Map<unknown>).get("f1")).toBe("v2");
  });

  it("revalidates baseline lifecycle candidates and waits for their store ACK", async () => {
    const recordId = "11111111-1111-1111-1111-111111111111";
    const documentName = "table:lifecycle-revalidation-route";
    const db = new TableDatabase();
    const ydoc = new Y.Doc();
    const ghost = new Y.Map<unknown>();
    ghost.set("f1", "stale baseline row");
    ydoc.getMap("records").set(recordId, ghost);
    ydoc.getMap<number>("rowOrderMap").set(recordId, 0);
    ydoc.getArray<string>("rowOrder").push([recordId]);
    ydoc.getMap("meta").set("version", 1);
    db.saveSnapshot(documentName, ydoc);

    let routeHandler: ((req: any, res: any) => Promise<void>) | null = null;
    let storeFinished = false;
    const instance = {
      documents: new Map(),
      openDirectConnection: async () => ({
        transact: async (fn: (doc: Y.Doc) => void) => {
          fn(ydoc);
          const payload = await (db as any).buildPersistPayloadAsync(ydoc, documentName, {});
          expect(payload.changes.new_records).toHaveProperty(recordId);
          expect(payload.changes.record_lifecycle_revalidation_ids).toEqual([recordId]);
          await Promise.resolve();
          (db as any).onStoreSuccess(ydoc, documentName, {
            version: 2,
            discarded_new_record_ids: [recordId],
          });
          storeFinished = true;
        },
        disconnect: async () => {},
      }),
    };
    const response = { status: vi.fn(function (this: any) { return this; }), json: vi.fn() };
    const ctx = {
      app: {
        post: vi.fn((_path: string, _middleware: unknown, handler: typeof routeHandler) => {
          routeHandler = handler;
        }),
      },
      requireLiveSecret: vi.fn(),
      resolveHocuspocusInstance: () => ({ instance, documentName }),
    } as any;

    setupApplyOpsRoutes(ctx);
    await routeHandler!({
      body: {
        resource_type: "table",
        document_name: documentName,
        op_id: "repair-1",
        ops: [{ op: "map.set", path: ["meta"], key: "probe", value: "1" }],
        require_store_success: true,
        record_lifecycle_revalidation_ids: [recordId],
        system_policy: "trusted_internal",
      },
    }, response);

    expect(storeFinished).toBe(true);
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "ok",
      data: expect.objectContaining({
        store_completed: true,
        record_lifecycle_candidates: 1,
        record_lifecycle_remaining: 0,
      }),
    }));
    clearTableSnapshot(documentName);
    ydoc.destroy();
  });

  it("does not retain lifecycle candidates when primitive validation fails", async () => {
    const recordId = "22222222-2222-2222-2222-222222222222";
    const documentName = "table:lifecycle-revalidation-invalid-op";
    const db = new TableDatabase();
    const ydoc = new Y.Doc();
    ydoc.getMap("records").set(recordId, new Y.Map<unknown>());
    db.saveSnapshot(documentName, ydoc);

    let routeHandler: ((req: any, res: any) => Promise<void>) | null = null;
    const instance = {
      documents: new Map(),
      openDirectConnection: async () => ({
        transact: async (fn: (doc: Y.Doc) => void) => fn(ydoc),
        disconnect: async () => {},
      }),
    };
    const response = { status: vi.fn(function (this: any) { return this; }), json: vi.fn() };
    const ctx = {
      app: {
        post: vi.fn((_path: string, _middleware: unknown, handler: typeof routeHandler) => {
          routeHandler = handler;
        }),
      },
      requireLiveSecret: vi.fn(),
      resolveHocuspocusInstance: () => ({ instance, documentName }),
    } as any;

    setupApplyOpsRoutes(ctx);
    await routeHandler!({
      body: {
        resource_type: "table",
        document_name: documentName,
        op_id: "repair-invalid-op",
        ops: [{ op: "unsupported" }],
        require_store_success: true,
        record_lifecycle_revalidation_ids: [recordId],
        system_policy: "trusted_internal",
      },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect((db as any).recordLifecycleRevalidationsByDocument.has(documentName)).toBe(false);
    clearTableSnapshot(documentName);
    ydoc.destroy();
  });

  it("returns an error when a strict apply-ops store rejects", async () => {
    let routeHandler: ((req: any, res: any) => Promise<void>) | null = null;
    const ydoc = new Y.Doc();
    const instance = {
      documents: new Map(),
      openDirectConnection: async () => ({
        transact: async (fn: (doc: Y.Doc) => void) => {
          fn(ydoc);
          throw new Error("store failed");
        },
        disconnect: async () => {},
      }),
    };
    const response = { status: vi.fn(function (this: any) { return this; }), json: vi.fn() };
    const ctx = {
      app: {
        post: vi.fn((_path: string, _middleware: unknown, handler: typeof routeHandler) => {
          routeHandler = handler;
        }),
      },
      requireLiveSecret: vi.fn(),
      resolveHocuspocusInstance: () => ({ instance, documentName: "table:strict-failure" }),
    } as any;

    setupApplyOpsRoutes(ctx);
    await routeHandler!({
      body: {
        resource_type: "table",
        document_name: "table:strict-failure",
        op_id: "repair-failure",
        ops: [{ op: "map.set", path: ["meta"], key: "probe", value: "1" }],
        require_store_success: true,
      },
    }, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
      status: "error",
      code: "apply_ops_failed",
      message: "store failed",
    }));
  });
});

describe("executePrimitiveOps", () => {
  it("applies Yjs binary updates", () => {
    const source = new Y.Doc();
    source.getText("default").insert(0, "hello");
    const update = Y.encodeStateAsUpdate(source);
    const target = new Y.Doc();

    expect(executePrimitiveOps({
      ydoc: target,
      documentName: "docs:1",
      routeContext,
      ops: [{ op: "y.update.apply", update_b64: Buffer.from(update).toString("base64") }],
    })).toEqual({ applied: 1 });
    expect(target.getText("default").toString()).toBe("hello");
  });

  it("replaces XML fragments from a Yjs update", () => {
    const source = new Y.Doc();
    const fragment = source.getXmlFragment("default");
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("new")]);
    fragment.insert(0, [paragraph]);
    const update = Y.encodeStateAsUpdate(source);

    const target = new Y.Doc();
    const targetFragment = target.getXmlFragment("default");
    targetFragment.insert(0, [new Y.XmlElement("old")]);

    expect(executePrimitiveOps({
      ydoc: target,
      documentName: "docs:1",
      routeContext,
      ops: [{ op: "xml.fragment.replace", fragment: "default", update_b64: Buffer.from(update).toString("base64") }],
    })).toEqual({ applied: 1 });
    expect(targetFragment.length).toBe(1);
    expect((targetFragment.get(0) as Y.XmlElement).nodeName).toBe("paragraph");
  });

  it("applies map, array, and order primitives", () => {
    const doc = new Y.Doc();
    expect(executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      routeContext,
      ops: [
        { op: "map.patch", path: ["records", "r1"], values: { f1: "v1", kind: "row" } },
        { op: "map.set", path: ["records"], key: "plain", value: { ok: true } },
        { op: "order.set", path: ["rowOrderMap"], positions: { r1: 1 } },
        { op: "array.replace", path: ["rowOrder"], values: ["r1"] },
      ],
    })).toEqual({ applied: 4 });

    expect((doc.getMap("records").get("r1") as Y.Map<unknown>).get("f1")).toBe("v1");
    expect(doc.getMap("records").get("plain")).toEqual({ ok: true });
    expect(doc.getMap("rowOrderMap").get("r1")).toBe(1);
    expect(doc.getArray("rowOrder").toArray()).toEqual(["r1"]);
  });

  it("plans TabData order.after against duplicate legacy bounds before writing", () => {
    const doc = new Y.Doc();
    const records = doc.getMap<Y.Map<unknown>>("records");
    const rowOrderMap = doc.getMap<string>("rowOrderMap");
    doc.transact(() => {
      for (const recordId of ["r1", "r2"]) {
        const record = new Y.Map<unknown>();
        record.set("__order", recordId === "r1" ? 1 : 2);
        records.set(recordId, record);
        rowOrderMap.set(recordId, "b0I");
      }
      doc.getArray<string>("rowOrder").push(["r1", "r2"]);
    });

    expect(() => executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        { op: "map.patch", path: ["records", "new-row"], values: { f1: "new" } },
        { op: "order.after", path: ["rowOrderMap"], key: "new-row", after_key: "r1" },
      ],
    })).not.toThrow();

    const inserted = records.get("new-row") as Y.Map<unknown>;
    expect(inserted.get("f1")).toBe("new");
    expect(inserted.get("__position_id")).toMatch(/^p1:/);
    expect(inserted.get("__order")).toEqual(expect.any(Number));
    expect(rowOrderMap.has("new-row")).toBe(true);
    expect(doc.getArray("rowOrder").toArray()).toEqual(["r1", "new-row", "r2"]);
  });

  it("plans order.after against an earlier Yjs update in the same batch", () => {
    const doc = new Y.Doc();
    const r1 = new Y.Map<unknown>();
    r1.set("__order", 2);
    r1.set("__position_id", "p1:a2");
    doc.getMap<Y.Map<unknown>>("records").set("r1", r1);
    doc.getMap<string>("rowOrderMap").set("r1", "a2");
    doc.getArray<string>("rowOrder").push(["r1"]);

    const updateDoc = new Y.Doc();
    Y.applyUpdate(updateDoc, Y.encodeStateAsUpdate(doc));
    const r2 = new Y.Map<unknown>();
    r2.set("__order", 0);
    r2.set("__position_id", "p1:a0");
    updateDoc.getMap<Y.Map<unknown>>("records").set("r2", r2);
    updateDoc.getMap<string>("rowOrderMap").set("r2", "a0");
    updateDoc.getArray<string>("rowOrder").insert(0, ["r2"]);
    const update = Y.encodeStateAsUpdate(updateDoc, Y.encodeStateVector(doc));

    executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        { op: "y.update.apply", update_b64: Buffer.from(update).toString("base64") },
        { op: "map.patch", path: ["records", "new-row"], values: {} },
        { op: "order.after", path: ["rowOrderMap"], key: "new-row", after_key: "r2" },
      ],
    });

    expect(doc.getArray("rowOrder").toArray()).toEqual(["r2", "new-row", "r1"]);
    expect([...doc.getMap<string>("rowOrderMap").entries()]
      .sort((left, right) => left[1].localeCompare(right[1]))
      .map(([recordId]) => recordId)).toEqual(["r2", "new-row", "r1"]);
    updateDoc.destroy();
  });

  it("creates an empty record shell before applying its TabData order", () => {
    const doc = new Y.Doc();
    const records = doc.getMap<Y.Map<unknown>>("records");
    const tail = new Y.Map<unknown>();
    tail.set("__order", 1);
    records.set("tail", tail);
    doc.getMap<string>("rowOrderMap").set("tail", "a0");
    doc.getArray<string>("rowOrder").push(["tail"]);

    executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        { op: "map.patch", path: ["records", "restored-empty"], values: {} },
        { op: "order.after", path: ["rowOrderMap"], key: "restored-empty", after_key: "tail" },
      ],
    });

    const restored = records.get("restored-empty");
    expect(restored).toBeInstanceOf(Y.Map);
    expect(restored!.get("__position_id")).toMatch(/^p1:/);
    expect(restored!.get("__order")).toEqual(expect.any(Number));
    expect(doc.getArray("rowOrder").toArray()).toEqual(["tail", "restored-empty"]);
  });

  it("rejects an order.after at the unknown tail of a truncated table before writing", () => {
    const doc = new Y.Doc();
    const record = new Y.Map<unknown>();
    record.set("__order", 5_000);
    doc.getMap<Y.Map<unknown>>("records").set("loaded-tail", record);
    doc.getMap<number>("rowOrderMap").set("loaded-tail", 5_000);
    doc.getArray<string>("rowOrder").push(["loaded-tail"]);
    doc.getMap("meta").set("is_truncated", true);
    doc.getMap("meta").set("total_records", 5_001);

    expect(() => executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        { op: "map.patch", path: ["records", "unsafe-tail"], values: {} },
        { op: "order.after", path: ["rowOrderMap"], key: "unsafe-tail", after_key: "loaded-tail" },
      ],
    })).toThrow("unknown tail of a truncated snapshot");

    expect(doc.getMap("records").has("unsafe-tail")).toBe(false);
    expect(doc.getArray("rowOrder").toArray()).toEqual(["loaded-tail"]);
  });

  it("keeps sequential TabData insertAfter operations in paste order", () => {
    const doc = new Y.Doc();
    const records = doc.getMap<Y.Map<unknown>>("records");
    const rowOrderMap = doc.getMap<string>("rowOrderMap");
    doc.transact(() => {
      for (const [recordId, order] of [["r1", 1], ["r2", 2]] as const) {
        const record = new Y.Map<unknown>();
        record.set("__order", order);
        records.set(recordId, record);
        rowOrderMap.set(recordId, "b0I");
      }
      doc.getArray<string>("rowOrder").push(["r1", "r2"]);
    });

    executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        { op: "map.patch", path: ["records", "pasted-a"], values: { f1: "a" } },
        { op: "order.after", path: ["rowOrderMap"], key: "pasted-a", after_key: "r1" },
        { op: "map.patch", path: ["records", "pasted-b"], values: { f1: "b" } },
        { op: "order.after", path: ["rowOrderMap"], key: "pasted-b", after_key: "pasted-a" },
      ],
    });

    expect(doc.getArray("rowOrder").toArray()).toEqual(["r1", "pasted-a", "pasted-b", "r2"]);
    const positionIds = ["pasted-a", "pasted-b", "r2"].map(
      recordId => records.get(recordId)!.get("__position_id"),
    );
    expect(positionIds.every(positionId => typeof positionId === "string" && positionId.startsWith("p1:")))
      .toBe(true);
    expect(new Set(positionIds).size).toBe(positionIds.length);
    expect([...rowOrderMap.entries()].sort((left, right) => {
      const leftPosition = left[1];
      const rightPosition = right[1];
      return leftPosition < rightPosition ? -1 : leftPosition > rightPosition ? 1 : left[0].localeCompare(right[0]);
    }).map(([recordId]) => recordId)).toEqual(["r1", "pasted-a", "pasted-b", "r2"]);
  });

  it("recomputes a stale PositionId for a Django legacy reorder in the same mutation", () => {
    const doc = new Y.Doc();
    const records = doc.getMap<Y.Map<unknown>>("records");
    const rowOrderMap = doc.getMap<string>("rowOrderMap");
    doc.transact(() => {
      for (const [recordId, order] of [["r1", 1], ["r2", 2]] as const) {
        const record = new Y.Map<unknown>();
        record.set("__order", order);
        if (recordId === "r2") record.set("__position_id", "p1:a0V");
        records.set(recordId, record);
        rowOrderMap.set(recordId, `b0${order}`);
      }
      doc.getArray<string>("rowOrder").push(["r1", "r2"]);
    });

    executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        {
          op: "map.patch",
          path: ["records", "r2"],
          values: { __position_id: null, __order: 0 },
        },
        { op: "order.after", path: ["rowOrderMap"], key: "r2", after_key: null },
      ],
    });

    const moved = records.get("r2")!;
    expect(moved.get("__position_id")).toMatch(/^p1:/);
    expect(moved.get("__position_id")).not.toBe("p1:a0V");
    expect(moved.get("__order")).toEqual(expect.any(Number));
    expect(doc.getArray("rowOrder").toArray()).toEqual(["r2", "r1"]);
  });

  it("keeps a Django rebalance map.patch sparse instead of rematerializing PositionId", () => {
    const doc = new Y.Doc();
    const records = doc.getMap<Y.Map<unknown>>("records");
    const rowOrderMap = doc.getMap<string>("rowOrderMap");
    const record = new Y.Map<unknown>();
    record.set("__order", 10);
    record.set("__position_id", "p1:a0");
    records.set("r1", record);
    rowOrderMap.set("r1", "a0");

    executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [{
        op: "map.patch",
        path: ["records", "r1"],
        values: { __position_id: null, __order: 1_000 },
      }],
    });

    expect(record.get("__position_id")).toBeNull();
    expect(record.get("__order")).toBe(1_000);
    expect(rowOrderMap.get("r1")).toBe("a0");
  });

  it("does not partially apply a TabData patch when PositionId planning fails", () => {
    const doc = new Y.Doc();
    const oversizedRecordId = "x".repeat(400);

    expect(() => executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        {
          op: "map.patch",
          path: ["records", oversizedRecordId],
          values: { f1: "must-not-leak", __position_id: null },
        },
        {
          op: "order.after",
          path: ["rowOrderMap"],
          key: oversizedRecordId,
          after_key: null,
        },
      ],
    })).toThrow("Allocated record PositionId exceeds the allocation limit");

    expect(doc.getMap("records").has(oversizedRecordId)).toBe(false);
    expect(doc.getMap("rowOrderMap").has(oversizedRecordId)).toBe(false);
    expect(doc.getArray("rowOrder").length).toBe(0);
  });

  it("rejects an invalid later op before a TabData batch can leave a half record", () => {
    const doc = new Y.Doc();

    expect(() => executePrimitiveOps({
      ydoc: doc,
      documentName: "table:1",
      resourceType: "table",
      routeContext,
      ops: [
        { op: "map.patch", path: ["records", "new-row"], values: { f1: "must-not-leak" } },
        { op: "table.record.upsert" },
      ],
    })).toThrow("unsupported primitive op: table.record.upsert");

    expect(doc.getMap("records").has("new-row")).toBe(false);
    expect(doc.getMap("rowOrderMap").has("new-row")).toBe(false);
  });

  it("keeps non-TabData order.after on the generic ordering contract", () => {
    const doc = new Y.Doc();
    const sceneOrderMap = doc.getMap<string>("sceneOrderMap");
    sceneOrderMap.set("s1", "a0");
    sceneOrderMap.set("s2", "a1");

    executePrimitiveOps({
      ydoc: doc,
      documentName: "video:1",
      resourceType: "video",
      routeContext,
      ops: [
        { op: "order.after", path: ["sceneOrderMap"], key: "new-scene", after_key: "s1" },
      ],
    });

    const position = sceneOrderMap.get("new-scene")!;
    expect(position > "a0" && position < "a1").toBe(true);
    expect(doc.getMap("records").size).toBe(0);
  });

  it("supports delete and delete_where primitives", () => {
    const doc = new Y.Doc();
    executePrimitiveOps({
      ydoc: doc,
      documentName: "video:1",
      routeContext,
      ops: [
        { op: "map.patch", path: ["elements", "e1"], values: { trackId: "subtitle" } },
        { op: "map.patch", path: ["elements", "e2"], values: { trackId: "main" } },
        { op: "map.delete_where", path: ["elements"], equals: { trackId: "subtitle" } },
        { op: "map.delete", path: ["elements"], key: "e2" },
      ],
    });
    expect(doc.getMap("elements").size).toBe(0);
  });

  it("rejects unsupported primitive ops", () => {
    const doc = new Y.Doc();
    expect(() => executePrimitiveOps({ ydoc: doc, documentName: "x", routeContext, ops: [{ op: "table.record.upsert" }] })).toThrow("unsupported primitive op: table.record.upsert");
  });
});
