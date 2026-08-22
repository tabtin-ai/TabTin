/**
 * P0 回归测试 — YJ-4 / YJ-5
 *
 * YJ-4: agent-push handleDocsPush 校验 update 合法性，损坏数据返回 400
 * YJ-5: base-collab-database _storeDocument 冲突重试耗尽后 throw 而非静默 return
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as Y from "yjs";

// ══════════════════════════════════════════════════
// YJ-4: Yjs update 校验
// ══════════════════════════════════════════════════

function createValidUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "Hello from agent");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

/**
 * 复现 agent-push.ts 中的校验逻辑：
 * 将 update 应用到临时 Y.Doc，如果抛异常说明 update 无效。
 */
function validateYjsUpdate(update: Uint8Array): { valid: boolean; error?: string } {
  try {
    const tempDoc = new Y.Doc();
    Y.applyUpdate(tempDoc, update);
    tempDoc.destroy();
    return { valid: true };
  } catch (err: unknown) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

describe("YJ-4: Yjs update validation (agent-push)", () => {
  it("accepts a valid Yjs update", () => {
    const update = createValidUpdate();
    const result = validateYjsUpdate(update);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("accepts an empty-state update", () => {
    const emptyDoc = new Y.Doc();
    const update = Y.encodeStateAsUpdate(emptyDoc);
    emptyDoc.destroy();
    const result = validateYjsUpdate(update);
    expect(result.valid).toBe(true);
  });

  it("rejects a completely empty Uint8Array", () => {
    const result = validateYjsUpdate(new Uint8Array(0));
    expect(result.valid).toBe(false);
  });

  it("rejects random garbage bytes", () => {
    const garbage = new Uint8Array([0xff, 0xfe, 0xab, 0x12, 0x34, 0x56, 0x78, 0x90]);
    const result = validateYjsUpdate(garbage);
    expect(result.valid).toBe(false);
  });

  it("rejects truncated update (first 3 bytes of a valid update)", () => {
    const valid = createValidUpdate();
    const truncated = valid.slice(0, 3);
    const result = validateYjsUpdate(truncated);
    expect(result.valid).toBe(false);
  });

  it("rejects single-byte input", () => {
    const result = validateYjsUpdate(new Uint8Array([0x00]));
    expect(result.valid).toBe(false);
  });

  it("valid update applied to temp doc does not affect original doc", () => {
    const originalDoc = new Y.Doc();
    originalDoc.getText("content").insert(0, "Original");

    const agentDoc = new Y.Doc();
    agentDoc.getText("content").insert(0, "Agent text");
    const update = Y.encodeStateAsUpdate(agentDoc);
    agentDoc.destroy();

    validateYjsUpdate(update);

    expect(originalDoc.getText("content").toString()).toBe("Original");
    originalDoc.destroy();
  });

  it("round-trip: base64 encode → decode → validate succeeds for valid update", () => {
    const update = createValidUpdate();
    const b64 = Buffer.from(update).toString("base64");
    const decoded = new Uint8Array(Buffer.from(b64, "base64"));
    const result = validateYjsUpdate(decoded);
    expect(result.valid).toBe(true);
  });

  it("round-trip: corrupted base64 string → validate fails", () => {
    const corruptedB64 = "dGhpcyBpcyBub3QgYSB5anMgdXBkYXRl"; // "this is not a yjs update"
    const decoded = new Uint8Array(Buffer.from(corruptedB64, "base64"));
    const result = validateYjsUpdate(decoded);
    expect(result.valid).toBe(false);
  });
});

// ══════════════════════════════════════════════════
// YJ-5: _storeDocument 冲突重试耗尽后 throw
// ══════════════════════════════════════════════════

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
    recordPush: vi.fn(),
  },
}));

vi.mock("../services/django-api.js", () => ({
  fetchCollabSnapshot: vi.fn(),
  persistCollabChanges: vi.fn(),
}));

vi.mock("../lib/retry.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock("../lib/collab-utils.js", async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    handleStoreError: vi.fn(async ({ error }: { error: unknown }) => {
      throw error;
    }),
  };
});

describe("YJ-5: _storeDocument throws on exhausted conflict retry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when conflict retry is still conflicted", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    (withRetry as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );

    let callCount = 0;
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      return { conflict: true, current_revn: callCount };
    });

    class TestDatabase extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        return {
          changes: { some: "data" },
          editor_type: "agent",
          editor_id: "test-agent",
        };
      }
      protected onStoreConflict() {}
    }

    const db = new TestDatabase();

    const ydoc = new Y.Doc();
    const storeParams = {
      documentName: "test:resource-1",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    await expect(
      (db as any)._storeDocument(storeParams),
    ).rejects.toThrow("Persist conflict not resolved after retry");

    ydoc.destroy();
  });

  it("does NOT throw when conflict retry succeeds", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    (withRetry as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );

    let callCount = 0;
    (persistCollabChanges as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { conflict: true, current_revn: 5 };
      return { success: true, version: 6 };
    });

    class TestDatabase extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        return {
          changes: { some: "data" },
          editor_type: "agent",
          editor_id: "test-agent",
        };
      }
      protected onStoreConflict() {}
      protected onStoreSuccess() {}
    }

    const db = new TestDatabase();

    const ydoc = new Y.Doc();
    const storeParams = {
      documentName: "test:resource-1",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    await expect(
      (db as any)._storeDocument(storeParams),
    ).resolves.toBeUndefined();

    ydoc.destroy();
  });

  it("returns silently when retryPayload is null (no changes after version reconciliation)", async () => {
    const { persistCollabChanges } = await import("../services/django-api.js");
    const { withRetry } = await import("../lib/retry.js");
    const { BaseCollabDatabase } = await import("../extensions/base-collab-database.js");

    (withRetry as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: () => Promise<unknown>) => fn(),
    );

    (persistCollabChanges as ReturnType<typeof vi.fn>).mockResolvedValue({
      conflict: true,
      current_revn: 5,
    });

    let buildCount = 0;

    class TestDatabase extends BaseCollabDatabase {
      protected getPrefix() { return "test:"; }
      protected getResourceType() { return "test"; }
      protected getModuleLabel() { return "TestDB"; }
      protected applySnapshotToDoc() {}
      protected buildPersistPayload() {
        buildCount++;
        if (buildCount === 1) {
          return {
            changes: { some: "data" },
            editor_type: "agent",
            editor_id: "test-agent",
          };
        }
        return null;
      }
      protected onStoreConflict() {}
    }

    const db = new TestDatabase();

    const ydoc = new Y.Doc();
    const storeParams = {
      documentName: "test:resource-1",
      state: Y.encodeStateAsUpdate(ydoc),
      document: ydoc,
      context: {},
      instance: null,
    };

    await expect(
      (db as any)._storeDocument(storeParams),
    ).resolves.toBeUndefined();

    ydoc.destroy();
  });
});
