/**
 * SCHEMA-VERSION 回归测试
 *
 * 验证 ensureSchemaVersion 在以下场景下的行为：
 * 1. 无版本号的遗留文档 → 写入当前版本
 * 2. 版本号匹配 → 原样返回
 * 3. 版本号低于当前 → 升级并调用迁移钩子
 * 4. 版本号高于当前（客户端更新） → warn 但不降级
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

const MOCK_SCHEMA_VERSION = 1;

vi.mock("@tabtin/doc-editor", () => ({
  DOC_SCHEMA_VERSION: MOCK_SCHEMA_VERSION,
}));

vi.mock("../services/django-api.js", () => ({
  fetchDocumentBinary: vi.fn(),
  storeDocumentUpdate: vi.fn(),
}));
vi.mock("../lib/converters.js", () => ({
  binaryToAllFormats: vi.fn().mockResolvedValue({
    html: "",
    json: {},
    plaintext: "",
    markdown: "",
  }),
  markdownToUpdateBinary: vi.fn(),
  pmJsonToUpdateBinary: vi.fn(),
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
vi.mock("../lib/collab-utils.js", () => ({
  parseResourceId: vi.fn((name: string, prefix: string) =>
    name.startsWith(prefix) ? name.slice(prefix.length) : null,
  ),
  extractEditorInfo: vi.fn(() => ({
    editorType: "user",
    editorId: "test-user",
    editorName: "Test",
    agentRunId: null,
  })),
  handleStoreError: vi.fn(),
}));

function createYDocBinary(schemaVersion?: number): Uint8Array {
  const doc = new Y.Doc();
  if (schemaVersion != null) {
    doc.getMap("meta").set("schema_version", schemaVersion);
  }
  const fragment = doc.getXmlFragment("default");
  const p = new Y.XmlElement("paragraph");
  p.insert(0, [new Y.XmlText("hello")]);
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

describe("ensureSchemaVersion", () => {
  let ensureSchemaVersion: (binary: Uint8Array, documentId: string) => Uint8Array;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("../extensions/database.js");
    ensureSchemaVersion = mod.ensureSchemaVersion;
  });

  it("遗留文档（无版本号）→ 写入当前版本", () => {
    const binary = createYDocBinary();
    expect(readSchemaVersion(binary)).toBeUndefined();

    const result = ensureSchemaVersion(binary, "test-doc-1");
    expect(readSchemaVersion(result)).toBe(MOCK_SCHEMA_VERSION);
  });

  it("版本号匹配 → 原样返回（引用相同）", () => {
    const binary = createYDocBinary(MOCK_SCHEMA_VERSION);
    const result = ensureSchemaVersion(binary, "test-doc-2");
    expect(result).toBe(binary);
  });

  it("版本号低于当前 → 升级到当前版本", () => {
    const binary = createYDocBinary(0);
    const result = ensureSchemaVersion(binary, "test-doc-3");
    expect(readSchemaVersion(result)).toBe(MOCK_SCHEMA_VERSION);
  });

  it("版本号高于当前 → 不降级，原样返回", () => {
    const futureVersion = MOCK_SCHEMA_VERSION + 5;
    const binary = createYDocBinary(futureVersion);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = ensureSchemaVersion(binary, "test-doc-4");

    expect(result).toBe(binary);
    expect(readSchemaVersion(result)).toBe(futureVersion);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("client may be newer"),
    );
    warnSpy.mockRestore();
  });

  it("不丢失原始文档内容", () => {
    const binary = createYDocBinary();
    const result = ensureSchemaVersion(binary, "test-doc-5");

    const doc = new Y.Doc();
    Y.applyUpdate(doc, result);
    const fragment = doc.getXmlFragment("default");
    expect(fragment.length).toBeGreaterThan(0);
    doc.destroy();
  });
});
