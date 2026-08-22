import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

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
    snapshotCacheSizes: {},
  },
}));

vi.mock("../services/django-api.js", () => ({
  fetchCollabSnapshot: vi.fn(),
  persistCollabChanges: vi.fn(),
}));

vi.mock("../lib/retry.js", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  extractHttpStatusCode: vi.fn(() => null),
}));

import { fetchCollabSnapshot } from "../services/django-api.js";
import { TableDatabase } from "../extensions/table-database.js";

function makeLiveDoc(): Y.Doc {
  const doc = new Y.Doc();
  const records = doc.getMap<unknown>("records");
  const addRecord = (recordId: string, cells: Record<string, unknown>) => {
    const record = new Y.Map<unknown>();
    for (const [fieldId, value] of Object.entries(cells)) record.set(fieldId, value);
    records.set(recordId, record);
  };

  doc.transact(() => {
    addRecord("r1", { f1: "local-edit" });
    addRecord("r2", { f1: "unchanged" });
    addRecord("r3", { f1: "local-new" });
    doc.getArray<string>("rowOrder").push(["r1", "r2", "r3"]);
    const meta = doc.getMap("meta");
    meta.set("fields", [{ id: "f1", name: "Text" }]);
    meta.set("version", 7);
    meta.set("table_name", "Test");
  });
  return doc;
}

const AUTHORITATIVE_SNAPSHOT = {
  records: {
    r1: { f1: "server-value" },
    r2: { f1: "unchanged" },
  },
  row_order: ["r1", "r2"],
  fields: [{ id: "f1", name: "Text" }],
  views: [],
  table_version: 7,
  table_name: "Test",
  table_id: "table-1",
  is_truncated: false,
  total_records: 2,
};

describe("missing table snapshot baseline recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rebuilds a DB baseline in a temporary doc and persists only local deltas", async () => {
    vi.mocked(fetchCollabSnapshot).mockResolvedValue(AUTHORITATIVE_SNAPSHOT);
    const db = new TableDatabase();
    const liveDoc = makeLiveDoc();
    const originalLiveDoc = liveDoc;

    const payload = await (db as any).buildPersistPayloadAsync(
      liveDoc,
      "table:table-1",
      { editorType: "user", editorId: "u1" },
    );

    expect(fetchCollabSnapshot).toHaveBeenCalledWith("table", "table-1");
    expect(liveDoc).toBe(originalLiveDoc);
    expect((liveDoc.getMap("records").get("r1") as Y.Map<unknown>).get("f1"))
      .toBe("local-edit");
    expect(payload.changes.changed_records).toEqual({
      r1: { f1: "local-edit" },
    });
    expect(payload.changes.new_records).toEqual({
      r3: { f1: "local-new" },
    });
    expect(payload.changes.deleted_record_ids).toEqual([]);

    (db as any).onStoreSuccess(liveDoc, "table:table-1", { version: 8 });
    expect((db as any).buildPersistPayload(liveDoc, "table:table-1", {})).toBeNull();

    liveDoc.destroy();
  });

  it("rejects an incomplete authoritative snapshot instead of degrading to a full write", async () => {
    vi.mocked(fetchCollabSnapshot).mockResolvedValue({
      ...AUTHORITATIVE_SNAPSHOT,
      records: { r1: { f1: "server-value" } },
      is_truncated: true,
    });
    const db = new TableDatabase();
    const liveDoc = makeLiveDoc();

    await expect(
      (db as any).buildPersistPayloadAsync(liveDoc, "table:table-1", {}),
    ).rejects.toThrow("Cannot rebuild complete snapshot baseline");
    expect(db.snapshotCache.has("table:table-1")).toBe(false);

    liveDoc.destroy();
  });
});
