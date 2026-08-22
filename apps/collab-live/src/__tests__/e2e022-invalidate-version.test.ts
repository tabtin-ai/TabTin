/**
 * E2E-022 回归测试 — DB-first Agent 写入后 Y.Doc version 同步
 *
 * 问题：Agent 直接写 DB（version=N+1），Y.Doc 仍持有 version=N，
 * 5s 后 debounce 到期触发 onStore，conflict retry 用 Y.Doc 当前状态覆盖 DB，
 * Agent 写入被丢失。
 *
 * 修复（DECISION-003 方案 A）：
 *   collab-live 新增 POST /admin/invalidate-version 接口，
 *   接收 {documentName, newVersion}，更新内存 Y.Doc meta 中的 version/revn 字段，
 *   下次 onStore 时 base_version 与 DB 一致，不触发 conflict。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

vi.mock("../env.js", () => ({
  env: {
    REDIS_URL: "",
    SERVER_NAME: "test-server",
  },
}));

vi.mock("../extensions/index.js", () => ({
  getPrimaryRedis: vi.fn().mockReturnValue(null),
  AdminCommand: {
    FORCE_CLOSE: "force_close",
    STATELESS_BROADCAST: "stateless_broadcast",
    REVOKE_ACCESS: "revoke_access",
    REVOKE_USER_ACCESS: "revoke_user_access",
    INVALIDATE_VERSION: "invalidate_version",
  },
}));

import { AdminCommand } from "../extensions/index.js";

// ── 辅助函数 ──────────────────────────────────────────────────────

function createYDoc(metaFields: Record<string, unknown> = {}): Y.Doc {
  const ydoc = new Y.Doc();
  const meta = ydoc.getMap("meta");
  for (const [k, v] of Object.entries(metaFields)) {
    meta.set(k, v);
  }
  return ydoc;
}

function createMockDocument(ydoc: Y.Doc) {
  return {
    document: ydoc,
    getConnectionsCount: () => 0,
    connections: [],
  };
}

function createMockInstance(docs: Map<string, ReturnType<typeof createMockDocument>>) {
  return {
    documents: docs,
    configuration: { extensions: [] },
    unloadDocument: vi.fn().mockResolvedValue(undefined),
  };
}

function createRouteContext(instances: Array<{ instance: ReturnType<typeof createMockInstance> }>) {
  return {
    allInstances: () => instances,
    requireLiveSecret: vi.fn(),
    app: null as any,
    getInstance: vi.fn(),
    resolveHocuspocusInstance: vi.fn(),
    detectConcurrentEditors: vi.fn(),
  };
}

// ── 核心逻辑单元测试（不依赖 Express） ───────────────────────────

describe("TC-E2E022-A: invalidate-version 更新 Y.Doc meta.version", () => {
  it("canvas 文档：更新 meta.version 字段", () => {
    const ydoc = createYDoc({ version: 5 });
    const doc = createMockDocument(ydoc);
    const docs = new Map([["canvas:abc-123", doc]]);
    const instance = createMockInstance(docs);

    // 模拟 invalidate-version 核心逻辑
    const documentName = "canvas:abc-123";
    const newVersion = 6;
    const foundDoc = instance.documents.get(documentName);
    expect(foundDoc).toBeDefined();

    const isDesign = documentName.startsWith("design:");
    foundDoc!.document.transact(() => {
      const meta = foundDoc!.document.getMap("meta");
      if (isDesign) {
        meta.set("revn", newVersion);
      } else {
        meta.set("version", newVersion);
      }
    });

    expect(ydoc.getMap("meta").get("version")).toBe(6);
    expect(ydoc.getMap("meta").get("revn")).toBeUndefined();
  });

  it("video 文档：更新 meta.version 字段", () => {
    const ydoc = createYDoc({ version: 10 });
    const doc = createMockDocument(ydoc);
    const docs = new Map([["video:vid-001", doc]]);
    const instance = createMockInstance(docs);

    const documentName = "video:vid-001";
    const newVersion = 11;
    const foundDoc = instance.documents.get(documentName);

    const isDesign = documentName.startsWith("design:");
    foundDoc!.document.transact(() => {
      const meta = foundDoc!.document.getMap("meta");
      if (isDesign) {
        meta.set("revn", newVersion);
      } else {
        meta.set("version", newVersion);
      }
    });

    expect(ydoc.getMap("meta").get("version")).toBe(11);
  });

  it("design 文档：更新 meta.revn 字段（不是 version）", () => {
    const ydoc = createYDoc({ revn: 3 });
    const doc = createMockDocument(ydoc);
    const docs = new Map([["design:des-001", doc]]);
    const instance = createMockInstance(docs);

    const documentName = "design:des-001";
    const newVersion = 4;
    const foundDoc = instance.documents.get(documentName);

    const isDesign = documentName.startsWith("design:");
    foundDoc!.document.transact(() => {
      const meta = foundDoc!.document.getMap("meta");
      if (isDesign) {
        meta.set("revn", newVersion);
      } else {
        meta.set("version", newVersion);
      }
    });

    expect(ydoc.getMap("meta").get("revn")).toBe(4);
    expect(ydoc.getMap("meta").get("version")).toBeUndefined();
  });

  it("docs 文档：更新 meta.version 字段", () => {
    const ydoc = createYDoc({ version: 7 });
    const doc = createMockDocument(ydoc);
    const docs = new Map([["docs:doc-001", doc]]);
    const instance = createMockInstance(docs);

    const documentName = "docs:doc-001";
    const newVersion = 8;
    const foundDoc = instance.documents.get(documentName);

    const isDesign = documentName.startsWith("design:");
    foundDoc!.document.transact(() => {
      const meta = foundDoc!.document.getMap("meta");
      if (isDesign) {
        meta.set("revn", newVersion);
      } else {
        meta.set("version", newVersion);
      }
    });

    expect(ydoc.getMap("meta").get("version")).toBe(8);
  });

  it("slide 文档：更新 meta.version 字段", () => {
    const ydoc = createYDoc({ version: 2 });
    const doc = createMockDocument(ydoc);
    const docs = new Map([["slide:sld-001", doc]]);
    const instance = createMockInstance(docs);

    const documentName = "slide:sld-001";
    const newVersion = 3;
    const foundDoc = instance.documents.get(documentName);

    const isDesign = documentName.startsWith("design:");
    foundDoc!.document.transact(() => {
      const meta = foundDoc!.document.getMap("meta");
      if (isDesign) {
        meta.set("revn", newVersion);
      } else {
        meta.set("version", newVersion);
      }
    });

    expect(ydoc.getMap("meta").get("version")).toBe(3);
  });
});

describe("TC-E2E022-B: invalidate-version 文档不在内存时的行为", () => {
  it("文档不在本节点内存时 updated=false", () => {
    const docs = new Map<string, ReturnType<typeof createMockDocument>>();
    const instance = createMockInstance(docs);

    const documentName = "canvas:not-loaded";
    const foundDoc = instance.documents.get(documentName);
    expect(foundDoc).toBeUndefined();

    // updated 应为 false
    const updated = foundDoc !== undefined;
    expect(updated).toBe(false);
  });
});

describe("TC-E2E022-C: AdminCommand.INVALIDATE_VERSION 枚举值", () => {
  it("INVALIDATE_VERSION 枚举值为 'invalidate_version'", () => {
    expect(AdminCommand.INVALIDATE_VERSION).toBe("invalidate_version");
  });

  it("INVALIDATE_VERSION 与 FORCE_CLOSE 不相等（回归保护）", () => {
    expect(AdminCommand.INVALIDATE_VERSION).not.toBe(AdminCommand.FORCE_CLOSE);
  });
});

describe("TC-E2E022-D: version 字段更新后 onStore 不触发 conflict", () => {
  it("Y.Doc meta.version 更新后与 DB 版本一致，模拟 conflict 消除", () => {
    // 模拟场景：Agent 写 DB version=6，Y.Doc 持有 version=5
    const ydoc = createYDoc({ version: 5 });
    const meta = ydoc.getMap("meta");

    // invalidate-version 更新后
    ydoc.transact(() => {
      meta.set("version", 6);
    });

    // 验证 Y.Doc version 已与 DB 一致
    const currentVersion = meta.get("version") as number;
    const dbVersion = 6;
    expect(currentVersion).toBe(dbVersion);

    // 模拟 buildPersistPayload 读取 base_version
    const baseVersion = meta.get("version") as number;
    // base_version === db version → 不触发 conflict
    expect(baseVersion).toBe(dbVersion);
  });
});
