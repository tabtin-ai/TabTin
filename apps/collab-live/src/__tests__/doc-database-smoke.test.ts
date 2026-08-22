/**
 * TabDoc database.ts 冒烟测试
 *
 * DT-005: fetchDocument 基本流程（空 ydoc、markdown 迁移、无效 documentName）
 * DT-006: storeDocument 基本流程（schema 注入、队列串行化）
 * DT-007: ensureSchemaVersion 边界（版本匹配/缺失/高于/低于）
 * DT-008: Database store queue 串行化验证
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

const MOCK_SCHEMA_VERSION = 2;

vi.mock("@tabtin/doc-editor", () => ({
  DOC_SCHEMA_VERSION: MOCK_SCHEMA_VERSION,
}));

const mockFetchDocumentBinary = vi.fn();
const mockStoreDocumentUpdate = vi.fn().mockResolvedValue({});

vi.mock("../services/django-api.js", () => ({
  fetchDocumentBinary: (...args: any[]) => mockFetchDocumentBinary(...args),
  storeDocumentUpdate: (...args: any[]) => mockStoreDocumentUpdate(...args),
}));

const mockMarkdownToUpdateBinary = vi.fn();
const mockPmJsonToUpdateBinary = vi.fn();
vi.mock("../lib/converters.js", () => ({
  binaryToAllFormats: vi.fn().mockResolvedValue({
    html: "<p>smoke</p>",
    json: { type: "doc", content: [] },
    plaintext: "smoke",
    markdown: "smoke",
  }),
  markdownToUpdateBinary: (...args: any[]) => mockMarkdownToUpdateBinary(...args),
  pmJsonToUpdateBinary: (...args: any[]) => mockPmJsonToUpdateBinary(...args),
}));
vi.mock("./metrics.js", () => ({
  metrics: {
    fetchErrors: 0,
    recordStoreLatency: vi.fn(),
    increment: vi.fn(),
  },
}));
vi.mock("../lib/retry.js", () => ({
  withRetry: vi.fn((fn: () => unknown) => fn()),
}));
vi.mock("../lib/collab-utils.js", () => {
  const editorInfo = {
    editorType: "user",
    editorId: "smoke-test",
    editorName: "Smoke",
    agentRunId: null,
    systemPolicy: null,
  };
  return {
    parseResourceId: vi.fn((name: string, prefix: string) =>
      name.startsWith(prefix) ? name.slice(prefix.length) : null,
    ),
    extractEditorInfo: vi.fn(() => editorInfo),
    // storeDocument 走 ForStore；缺 mock 时 TypeError，API 一次都不会打
    extractEditorInfoForStore: vi.fn(() => editorInfo),
    handleStoreError: vi.fn(),
  };
});

function createDocBinary(content: string, schemaVersion?: number): Uint8Array {
  const doc = new Y.Doc();
  if (schemaVersion != null) {
    doc.getMap("meta").set("schema_version", schemaVersion);
  }
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText(content)]);
  fragment.insert(0, [p]);
  const binary = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return binary;
}

function readSchemaVersion(binary: Uint8Array): number | undefined {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, binary);
  const version = doc.getMap("meta").get("schema_version") as number | undefined;
  doc.destroy();
  return version;
}

// ══════════════════════════════════════════════════════════
// DT-005: fetchDocument 冒烟
// ══════════════════════════════════════════════════════════

describe("DT-005: fetchDocument 冒烟", () => {
  let Database: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../extensions/database.js");
    Database = mod.Database;
  });

  it("空 ydoc fetch 返回有效 delta", async () => {
    const binary = createDocBinary("hello smoke", MOCK_SCHEMA_VERSION);
    const b64 = Buffer.from(binary).toString("base64");

    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: b64,
      has_binary: true,
      description_markdown: "",
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:smoke-1",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.byteLength).toBeGreaterThan(0);

    Y.applyUpdate(ydoc, result);
    const fragment = ydoc.getXmlFragment("default");
    expect(fragment.length).toBeGreaterThan(0);

    ydoc.destroy();
  });

  it("无效 documentName 返回 null", async () => {
    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "invalid:no-prefix",
      document: ydoc,
      context: {},
    });

    expect(result).toBeNull();
    expect(mockFetchDocumentBinary).not.toHaveBeenCalled();

    ydoc.destroy();
  });

  it("无 binary 且无 markdown 返回 null", async () => {
    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: "",
      has_binary: false,
      description_markdown: "",
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:empty-doc",
      document: ydoc,
      context: {},
    });

    expect(result).toBeNull();
    ydoc.destroy();
  });

  it("无 binary 但有 markdown 时只在内存中生成兼容 binary", async () => {
    const migrationBinary = createDocBinary("from markdown");
    mockMarkdownToUpdateBinary.mockResolvedValue(migrationBinary);
    mockStoreDocumentUpdate.mockResolvedValue({});

    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: "",
      has_binary: false,
      description_markdown: "# Hello Markdown",
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:md-migrate",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(mockMarkdownToUpdateBinary).toHaveBeenCalledWith("# Hello Markdown");
    expect(mockPmJsonToUpdateBinary).not.toHaveBeenCalled();
    expect(mockStoreDocumentUpdate).not.toHaveBeenCalled();

    ydoc.destroy();
  });

  it("同一文档重复只读 fetch 复用兼容 binary，避免内容重复", async () => {
    const migrationBinary = createDocBinary("repeatable read");
    mockPmJsonToUpdateBinary.mockReturnValue(migrationBinary);
    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: "",
      has_binary: false,
      description_json: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "repeatable read" }] }],
      },
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const firstDelta = await fetchFn({
      documentName: "docs:repeat-read",
      document: ydoc,
      context: {},
    });
    Y.applyUpdate(ydoc, firstDelta);

    const secondDelta = await fetchFn({
      documentName: "docs:repeat-read",
      document: ydoc,
      context: {},
    });
    Y.applyUpdate(ydoc, secondDelta);

    expect(mockPmJsonToUpdateBinary).toHaveBeenCalledTimes(1);
    expect(ydoc.getXmlFragment("default").length).toBe(1);
    expect(ydoc.getXmlFragment("default").toString()).toContain("repeatable read");
    ydoc.destroy();
  });

  it("只读迁移不持久化，也不阻塞加载", async () => {
    const migrationBinary = createDocBinary("unpersisted");
    mockPmJsonToUpdateBinary.mockReturnValue(migrationBinary);

    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: "",
      has_binary: false,
      description_markdown: "x",
      description_json: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
      },
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:read-only-pm-json",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(mockStoreDocumentUpdate).not.toHaveBeenCalled();

    // 未把本地生成的 state merge 进活动 ydoc
    expect(ydoc.getXmlFragment("default").length).toBe(0);
    ydoc.destroy();
  });

  it("只读迁移使用本地兼容 binary，不回拉或持久化", async () => {
    const migrationBinary = createDocBinary("local-migration");
    mockPmJsonToUpdateBinary.mockReturnValue(migrationBinary);
    mockFetchDocumentBinary
      .mockResolvedValue({
        binary_b64: "",
        has_binary: false,
        description_json: {
          type: "doc",
          content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
        },
      });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:read-only-no-refetch",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(mockFetchDocumentBinary).toHaveBeenCalledTimes(1);
    expect(mockStoreDocumentUpdate).not.toHaveBeenCalled();
    Y.applyUpdate(ydoc, result);
    const text = ydoc.getXmlFragment("default").toString();
    expect(text).toContain("local-migration");
    ydoc.destroy();
  });

  it("无 binary 时优先用 description_json，避免 markdown 洗掉导入样式", async () => {
    const migrationBinary = createDocBinary("from pm_json");
    mockPmJsonToUpdateBinary.mockReturnValue(migrationBinary);
    mockStoreDocumentUpdate.mockResolvedValue({});

    const pmJson = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "red", marks: [{ type: "textStyle", attrs: { color: "#ff0000" } }] },
          ],
        },
      ],
    };

    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: "",
      has_binary: false,
      description_markdown: "red", // intentionally lossy
      description_json: pmJson,
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:pm-json-migrate",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(mockPmJsonToUpdateBinary).toHaveBeenCalledWith(pmJson);
    expect(mockMarkdownToUpdateBinary).not.toHaveBeenCalled();
    expect(mockStoreDocumentUpdate).not.toHaveBeenCalled();

    ydoc.destroy();
  });

  it("description_json 内容为空时回退 markdown 迁移", async () => {
    const migrationBinary = createDocBinary("from markdown fallback");
    mockMarkdownToUpdateBinary.mockResolvedValue(migrationBinary);
    mockStoreDocumentUpdate.mockResolvedValue({});

    mockFetchDocumentBinary.mockResolvedValue({
      binary_b64: "",
      has_binary: false,
      description_markdown: "# Fallback Markdown",
      description_json: { type: "doc", content: [] },
    });

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    const result = await fetchFn({
      documentName: "docs:empty-pm-json-fallback",
      document: ydoc,
      context: {},
    });

    expect(result).toBeInstanceOf(Uint8Array);
    expect(mockMarkdownToUpdateBinary).toHaveBeenCalledWith("# Fallback Markdown");
    expect(mockPmJsonToUpdateBinary).not.toHaveBeenCalled();
    expect(mockStoreDocumentUpdate).not.toHaveBeenCalled();

    ydoc.destroy();
  });

  it("API 错误时抛异常", async () => {
    mockFetchDocumentBinary.mockRejectedValue(new Error("API down"));

    const ydoc = new Y.Doc();
    const db = new Database();
    const fetchFn = (db as any).configuration.fetch;

    await expect(
      fetchFn({
        documentName: "docs:error-doc",
        document: ydoc,
        context: {},
      }),
    ).rejects.toThrow("API down");

    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════════════════
// DT-006: storeDocument 冒烟
// ══════════════════════════════════════════════════════════

describe("DT-006: storeDocument 冒烟", () => {
  let Database: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../extensions/database.js");
    Database = mod.Database;
  });

  it("store 将 binary 发送到 Django API", async () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("store test")]);
    fragment.insert(0, [p]);

    const state = Y.encodeStateAsUpdate(ydoc);
    const db = new Database();
    const storeFn = (db as any).configuration.store;

    await storeFn({
      documentName: "docs:store-1",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    expect(mockStoreDocumentUpdate).toHaveBeenCalledTimes(1);
    const sentDocId = mockStoreDocumentUpdate.mock.calls[0][0];
    expect(sentDocId).toBe("store-1");

    ydoc.destroy();
  });

  it("store 的 binary 包含 schema_version", async () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("default");
    const p = new Y.XmlElement("paragraph");
    p.insert(0, [new Y.XmlText("version check")]);
    fragment.insert(0, [p]);

    const stateWithoutSchema = Y.encodeStateAsUpdate(ydoc);
    expect(readSchemaVersion(stateWithoutSchema)).toBeUndefined();

    const db = new Database();
    const storeFn = (db as any).configuration.store;

    await storeFn({
      documentName: "docs:schema-inject",
      document: ydoc,
      state: stateWithoutSchema,
      context: {},
      instance: null,
    });

    const sentB64 = mockStoreDocumentUpdate.mock.calls[0][1];
    const sentBinary = new Uint8Array(Buffer.from(sentB64, "base64"));
    expect(readSchemaVersion(sentBinary)).toBe(MOCK_SCHEMA_VERSION);

    ydoc.destroy();
  });

  it("无效 documentName 的 store 不调用 API", async () => {
    const ydoc = new Y.Doc();
    const state = Y.encodeStateAsUpdate(ydoc);
    const db = new Database();
    const storeFn = (db as any).configuration.store;

    await storeFn({
      documentName: "invalid:no-docs-prefix",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    expect(mockStoreDocumentUpdate).not.toHaveBeenCalled();
    ydoc.destroy();
  });
});

// ══════════════════════════════════════════════════════════
// DT-007: ensureSchemaVersion 边界
// ══════════════════════════════════════════════════════════

describe("DT-007: ensureSchemaVersion 边界", () => {
  let ensureSchemaVersion: (binary: Uint8Array, docId: string) => Uint8Array;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../extensions/database.js");
    ensureSchemaVersion = mod.ensureSchemaVersion;
  });

  it("版本匹配时原样返回（引用相同）", () => {
    const binary = createDocBinary("match", MOCK_SCHEMA_VERSION);
    const result = ensureSchemaVersion(binary, "test");
    expect(result).toBe(binary);
  });

  it("版本缺失时注入当前版本", () => {
    const binary = createDocBinary("no-version");
    expect(readSchemaVersion(binary)).toBeUndefined();

    const result = ensureSchemaVersion(binary, "test");
    expect(readSchemaVersion(result)).toBe(MOCK_SCHEMA_VERSION);
  });

  it("版本低于当前时触发迁移并更新", () => {
    const binary = createDocBinary("old-version", 1);
    expect(readSchemaVersion(binary)).toBe(1);

    const result = ensureSchemaVersion(binary, "test");
    expect(readSchemaVersion(result)).toBe(MOCK_SCHEMA_VERSION);
  });

  it("版本高于当前时原样返回（warn 但不降级）", () => {
    const binary = createDocBinary("future-version", 999);
    const result = ensureSchemaVersion(binary, "test");

    expect(result).toBe(binary);
    expect(readSchemaVersion(result)).toBe(999);
  });
});

// ══════════════════════════════════════════════════════════
// DT-008: Database store queue 串行化
// ══════════════════════════════════════════════════════════

describe("DT-008: Database store queue 串行化", () => {
  let Database: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../extensions/database.js");
    Database = mod.Database;
  });

  it("同一 documentName 的多次 store 串行执行", async () => {
    const executionOrder: number[] = [];

    mockStoreDocumentUpdate.mockImplementation(async () => {
      const idx = executionOrder.length + 1;
      executionOrder.push(idx);
      await new Promise((r) => setTimeout(r, 10));
    });

    const ydoc = new Y.Doc();
    const state = Y.encodeStateAsUpdate(ydoc);
    const db = new Database();

    const p1 = (db as any)._serializedStore({
      documentName: "docs:queue-test",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    const p2 = (db as any)._serializedStore({
      documentName: "docs:queue-test",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    await Promise.all([p1, p2]);

    expect(mockStoreDocumentUpdate).toHaveBeenCalledTimes(2);
    expect(executionOrder).toEqual([1, 2]);

    ydoc.destroy();
  });

  it("不同 documentName 的 store 互不阻塞", async () => {
    const order: string[] = [];

    mockStoreDocumentUpdate.mockImplementation(async (docId: string) => {
      order.push(`start:${docId}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${docId}`);
    });

    const ydoc = new Y.Doc();
    const state = Y.encodeStateAsUpdate(ydoc);
    const db = new Database();

    const p1 = (db as any)._serializedStore({
      documentName: "docs:queue-a",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    const p2 = (db as any)._serializedStore({
      documentName: "docs:queue-b",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    await Promise.all([p1, p2]);

    expect(mockStoreDocumentUpdate).toHaveBeenCalledTimes(2);
    ydoc.destroy();
  });

  it("afterUnloadDocument 等待 pending store 完成", async () => {
    let resolveStore: (() => void) | null = null;
    mockStoreDocumentUpdate.mockImplementation(
      () => new Promise<void>((r) => { resolveStore = r; }),
    );

    const ydoc = new Y.Doc();
    const state = Y.encodeStateAsUpdate(ydoc);
    const db = new Database();

    const storePromise = (db as any)._serializedStore({
      documentName: "docs:unload-test",
      document: ydoc,
      state,
      context: {},
      instance: null,
    });

    let unloadDone = false;
    const unloadPromise = db.afterUnloadDocument({ documentName: "docs:unload-test" }).then(() => {
      unloadDone = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(unloadDone).toBe(false);

    resolveStore!();
    await storePromise;
    await unloadPromise;

    expect(unloadDone).toBe(true);
    ydoc.destroy();
  });

  it("只读迁移缓存按 LRU 上限淘汰，淘汰后允许重新构建", async () => {
    const {
      COMPLETED_MIGRATION_CACHE_MAX_ENTRIES,
    } = await import("../extensions/database.js");
    const migrationBinary = createDocBinary("bounded migration cache");
    let migrationBuilds = 0;
    mockPmJsonToUpdateBinary.mockImplementation(() => {
      migrationBuilds += 1;
      return migrationBinary;
    });
    mockFetchDocumentBinary.mockImplementation(async () => ({
      binary_b64: "",
      has_binary: false,
      description_json: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "bounded" }] }],
      },
    }));

    const opened = new Map<string, Y.Doc>();
    const open = async (documentId: string) => {
      const ydoc = new Y.Doc();
      opened.set(documentId, ydoc);
      const db = new Database();
      const result = await (db as any).configuration.fetch({
        documentName: `docs:${documentId}`,
        document: ydoc,
        context: {},
      });
      expect(result).toBeInstanceOf(Uint8Array);
    };

    for (let index = 0; index < COMPLETED_MIGRATION_CACHE_MAX_ENTRIES; index += 1) {
      await open(`bounded-${index}`);
    }
    // Touch the first entry so LRU order is observable.
    await open("bounded-0");
    await open(`bounded-${COMPLETED_MIGRATION_CACHE_MAX_ENTRIES}`);
    await open("bounded-1");

    expect(migrationBuilds).toBe(COMPLETED_MIGRATION_CACHE_MAX_ENTRIES + 2);
    for (const ydoc of opened.values()) ydoc.destroy();
  });
});
