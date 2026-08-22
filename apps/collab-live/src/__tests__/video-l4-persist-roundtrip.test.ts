/**
 * Video L4 修复验证测试
 *
 * 覆盖三项修复：
 *   1. op_id 幂等：buildPersistPayload 生成 video_collab_* 格式的 op_id
 *   2. digest 优化：computeTimelineDigest 直接遍历 Y.Doc maps，替代 JSON.stringify 全量比较
 *   3. buildPersistPayload 往返正确性
 *   4. mergeTimelineIntoDoc 合并正确性
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as Y from "yjs";

import {
  applyTimelineToDoc,
  mergeTimelineIntoDoc,
  docToTimeline,
  computeTimelineDigest,
  VideoDatabase,
} from "../extensions/video-database.js";

function makeTimeline(overrides?: Record<string, unknown>) {
  return {
    settings: {
      fps: 30,
      canvasSize: { width: 1920, height: 1080 },
      background: { type: "color", color: "#000000" },
    },
    metadata: {
      id: "proj-1",
      name: "Test Project",
      duration: 60,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    scenes: [
      {
        id: "scene-1",
        name: "主场景",
        isMain: true,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        tracks: [
          {
            id: "t1",
            type: "video",
            name: "Video 1",
            elements: [
              { id: "e1", type: "video", startTime: 0, duration: 5 },
              { id: "e2", type: "video", startTime: 5, duration: 3 },
            ],
          },
          {
            id: "t2",
            type: "audio",
            name: "Audio 1",
            elements: [
              { id: "e3", type: "audio", startTime: 0, duration: 10 },
            ],
          },
        ],
      },
    ],
    currentSceneId: "scene-1",
    version: 1,
    ...overrides,
  };
}

// ─── 1. op_id 幂等性测试 ──────────────────────────────────

describe("VID-L4: buildPersistPayload op_id 幂等", () => {
  let db: VideoDatabase;

  beforeEach(() => {
    db = new VideoDatabase();
  });

  it("payload 包含 video_collab_* 格式的 op_id", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:opid-format";
    const payload = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload).not.toBeNull();
    expect(payload.op_id).toBeDefined();
    expect(payload.op_id).toMatch(/^video_collab_\d+_[a-z0-9]+$/);
  });

  it("每次调用生成不同的 op_id", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:opid-unique";
    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();

    doc.getMap("meta").set("name", "Changed");
    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    doc.getMap("meta").set("name", "Changed Again");
    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();

    expect(payload1.op_id).not.toBe(payload2.op_id);
  });

  it("op_id 同时出现在 payload 顶层", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const payload = (db as any).buildPersistPayload(doc, "video:opid-top", {});
    expect(payload.op_id).toBeDefined();
    expect(typeof payload.op_id).toBe("string");
  });
});

// ─── 2. buildPersistPayload 往返测试 ───────────────────────

describe("VID-L4: buildPersistPayload roundtrip", () => {
  let db: VideoDatabase;

  beforeEach(() => {
    db = new VideoDatabase();
  });

  it("首次 store（无 snapshot）返回完整 payload", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:rt-first";
    const payload = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload).not.toBeNull();
    expect(payload.changes.timeline_data).toBeDefined();
    expect(payload.changes.timeline_data.scenes).toHaveLength(1);
    expect(payload.changes.base_version).toBe(1);
  });

  it("onSnapshotLoaded 后无变更返回 null", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:rt-no-change";
    (db as any).onSnapshotLoaded(docName, doc);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();
  });

  it("编辑元素后返回 payload，store 成功后再次返回 null", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:rt-edit-cycle";
    (db as any).onSnapshotLoaded(docName, doc);

    doc.transact(() => {
      const el = doc.getMap("elements").get("e1") as Y.Map<unknown>;
      el.set("duration", 99);
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    expect(payload.changes.timeline_data).toBeDefined();

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).toBeNull();
  });

  it("applySnapshotToDoc → onSnapshotLoaded → 编辑 → persist 全链路", () => {
    const docName = "video:rt-full-chain";
    const snapshot = { timeline_data: makeTimeline() };

    const doc = new Y.Doc();
    (db as any).applySnapshotToDoc(doc, snapshot);
    (db as any).onSnapshotLoaded(docName, doc);

    doc.transact(() => {
      doc.getMap("settings").set("fps", 60);
    });

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();
    const tl = payload.changes.timeline_data;
    expect(tl.settings.fps).toBe(60);
    expect(payload.changes.base_version).toBe(1);

    (db as any).onStoreSuccess(doc, docName, { version: 2 });
    expect(doc.getMap("meta").get("version")).toBe(2);
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();
  });

  it("连续 store 后 snapshotCache 正确更新版本号", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());
    const docName = "video:rt-consecutive";

    const p1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(p1).not.toBeNull();
    (db as any).onStoreSuccess(doc, docName, { version: 1 });

    doc.getMap("meta").set("name", "V2");
    const p2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(p2).not.toBeNull();
    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const cached = db.snapshotCache.get(docName) as Record<string, unknown>;
    expect(cached.version).toBe(2);
    expect((db as any).buildPersistPayload(doc, docName, {})).toBeNull();
  });

  it("version 变更不单独触发 persist（digest 排除 version）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());
    const docName = "video:rt-version-only";

    (db as any).onSnapshotLoaded(docName, doc);

    doc.getMap("meta").set("version", 999);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();
  });
});

// ─── 3. mergeTimelineIntoDoc 合并正确性 ────────────────────

describe("VID-L4: mergeTimelineIntoDoc 合并正确性", () => {
  it("新增轨道正确合并到已有文档", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "主场景", isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
            { id: "e2", type: "video", startTime: 5, duration: 3 },
          ]},
          { id: "t2", type: "audio", name: "Audio 1", elements: [
            { id: "e3", type: "audio", startTime: 0, duration: 10 },
          ]},
          { id: "t3", type: "text", name: "Subtitle", elements: [
            { id: "e4", type: "text", startTime: 0, duration: 5, content: "Hello" },
          ]},
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(3);
    expect(trackOrderMap.has("t3")).toBe(true);

    const elementsMap = doc.getMap("elements");
    const e4 = elementsMap.get("e4") as Y.Map<unknown>;
    expect(e4).toBeDefined();
    expect(e4.get("content")).toBe("Hello");
  });

  it("三方合并保留用户并发修改", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("settings").set("fps", 60);
    });

    const agentTimeline = makeTimeline({
      settings: {
        fps: 30,
        canvasSize: { width: 1920, height: 1080 },
        background: { type: "color", color: "#ffffff" },
      },
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(doc.getMap("settings").get("fps")).toBe(60);
    expect(doc.getMap("settings").get("bgColor")).toBe("#ffffff");
  });

  it("元素属性三方合并正确", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
      e1.set("startTime", 10);
    });

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "主场景", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1",
          elements: [
            { id: "e1", type: "video", startTime: 0, duration: 8 },
            { id: "e2", type: "video", startTime: 5, duration: 3 },
          ],
        }, {
          id: "t2", type: "audio", name: "Audio 1",
          elements: [{ id: "e3", type: "audio", startTime: 0, duration: 10 }],
        }],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
    expect(e1.get("startTime")).toBe(10);
    expect(e1.get("duration")).toBe(8);
  });

  it("applyTimelineToDoc → docToTimeline 往返数据不丢失", () => {
    const timeline = makeTimeline();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, timeline);

    const result = docToTimeline(doc);

    expect(result.settings).toEqual({
      fps: 30,
      canvasSize: { width: 1920, height: 1080 },
      background: { type: "color", color: "#000000" },
    });

    const scenes = result.scenes as Record<string, unknown>[];
    expect(scenes).toHaveLength(1);

    const tracks = scenes[0].tracks as Record<string, unknown>[];
    expect(tracks).toHaveLength(2);
    expect(tracks[0].id).toBe("t1");

    const elements = tracks[0].elements as Record<string, unknown>[];
    expect(elements).toHaveLength(2);
    expect(elements[0].id).toBe("e1");
    expect(elements[0].startTime).toBe(0);
    expect(elements[0].duration).toBe(5);
    expect(elements[1].id).toBe("e2");
  });

  it("多场景 applyTimelineToDoc → docToTimeline 往返正确", () => {
    const timeline = makeTimeline({
      scenes: [
        {
          id: "s1", name: "Intro", isMain: true,
          tracks: [{ id: "t1", type: "video", name: "V1", elements: [] }],
        },
        {
          id: "s2", name: "Main", isMain: false,
          tracks: [
            { id: "t2", type: "video", name: "V2", elements: [
              { id: "e1", type: "video", startTime: 0, duration: 10 },
            ]},
            { id: "t3", type: "audio", name: "A1", elements: [] },
          ],
        },
      ],
    });

    const doc = new Y.Doc();
    applyTimelineToDoc(doc, timeline);
    const result = docToTimeline(doc);

    const scenes = result.scenes as Record<string, unknown>[];
    expect(scenes).toHaveLength(2);
    expect(scenes[0].id).toBe("s1");
    expect(scenes[1].id).toBe("s2");

    const s2tracks = scenes[1].tracks as Record<string, unknown>[];
    expect(s2tracks).toHaveLength(2);
    expect((s2tracks[0].elements as unknown[]).length).toBe(1);
  });
});

// ─── 4. computeTimelineDigest 正确性测试 ──────────────────

describe("VID-L4: computeTimelineDigest 正确性", () => {
  it("相同内容生成相同 digest", () => {
    const doc1 = new Y.Doc();
    applyTimelineToDoc(doc1, makeTimeline());

    const doc2 = new Y.Doc();
    applyTimelineToDoc(doc2, makeTimeline());

    expect(computeTimelineDigest(doc1)).toBe(computeTimelineDigest(doc2));
  });

  it("不同内容生成不同 digest", () => {
    const doc1 = new Y.Doc();
    applyTimelineToDoc(doc1, makeTimeline());

    const doc2 = new Y.Doc();
    applyTimelineToDoc(doc2, makeTimeline({
      settings: { fps: 60, canvasSize: { width: 1920, height: 1080 }, background: { type: "color", color: "#000" } },
    }));

    expect(computeTimelineDigest(doc1)).not.toBe(computeTimelineDigest(doc2));
  });

  it("修改元素属性后 digest 变化", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const before = computeTimelineDigest(doc);

    doc.transact(() => {
      const el = doc.getMap("elements").get("e1") as Y.Map<unknown>;
      el.set("duration", 999);
    });

    const after = computeTimelineDigest(doc);
    expect(before).not.toBe(after);
  });

  it("version 变化不影响 digest", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const before = computeTimelineDigest(doc);

    doc.getMap("meta").set("version", 42);

    const after = computeTimelineDigest(doc);
    expect(before).toBe(after);
  });

  it("新增轨道后 digest 变化", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());
    const before = computeTimelineDigest(doc);

    const timeline2 = makeTimeline({
      scenes: [{
        id: "scene-1", name: "主场景", isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
            { id: "e2", type: "video", startTime: 5, duration: 3 },
          ]},
          { id: "t2", type: "audio", name: "Audio 1", elements: [
            { id: "e3", type: "audio", startTime: 0, duration: 10 },
          ]},
          { id: "t3", type: "text", name: "Sub", elements: [] },
        ],
      }],
    });
    applyTimelineToDoc(doc, timeline2);

    const after = computeTimelineDigest(doc);
    expect(before).not.toBe(after);
  });

  it("digest 格式为 'hash1:hash2'", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const digest = computeTimelineDigest(doc);
    expect(digest).toMatch(/^\d+:\d+$/);
  });

  it("空文档的 digest 稳定", () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();

    expect(computeTimelineDigest(doc1)).toBe(computeTimelineDigest(doc2));
  });
});
