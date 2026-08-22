/**
 * VID-001 ~ VID-008 回归测试（Y.Array → Y.Map 迁移后）
 *
 * VID-001: applyTimelineToDoc 复用 trackElements Y.Array，不新建孤立实例
 *          [迁移后] trackElementOrderMaps（Y.Map）正确填充，不产生 ID 翻倍
 * VID-002: applyTimelineToDoc 复用 sceneTracks Y.Array，不新建孤立实例
 * VID-003: prepareYDocForMerge 不再清空 Y.Array（Y.Map 天然幂等）
 * VID-004: docToTimeline 对 trackOrderMap/sceneOrderMap 去重（Y.Map 天然唯一 key）
 * VID-005: applyTimelineToDoc 始终写入 meta.sceneName 作为单场景路径回退
 * VID-006: mergeTimelineIntoDoc 始终更新 meta.sceneName，多→单场景降级不丢数据
 * VID-008: docToTimeline 使用 meta 中稳定的 updatedAt，digest 比较不因时间戳失效
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  applyTimelineToDoc,
  mergeTimelineIntoDoc,
  docToTimeline,
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
        name: "Main",
        isMain: true,
        tracks: [
          {
            id: "t1",
            type: "video",
            name: "Video 1",
            elements: [
              { id: "e1", type: "video", startTime: 0, duration: 5 },
              { id: "e2", type: "text", startTime: 2, duration: 3 },
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

function makeMultiSceneTimeline() {
  return makeTimeline({
    scenes: [
      {
        id: "s1",
        name: "Scene A",
        isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "V1", elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }] },
        ],
      },
      {
        id: "s2",
        name: "Scene B",
        isMain: false,
        tracks: [
          { id: "t2", type: "audio", name: "A1", elements: [{ id: "e2", type: "audio", startTime: 0, duration: 8 }] },
        ],
      },
    ],
  });
}

// ─── VID-001: trackElementOrderMaps（Y.Map）不产生 ID 翻倍 ─

describe("VID-001: applyTimelineToDoc 使用 Y.Map 不产生 ID 翻倍", () => {
  it("二次 apply 后 trackElementOrderMaps 内容正确（无 ID 翻倍）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());
    applyTimelineToDoc(doc, makeTimeline());

    const teMap = doc.getMap("trackElementOrderMaps");
    const t1OrderMap = teMap.get("t1") as Y.Map<number>;
    expect(t1OrderMap).toBeInstanceOf(Y.Map);
    expect(t1OrderMap.size).toBe(2);
    expect(t1OrderMap.has("e1")).toBe(true);
    expect(t1OrderMap.has("e2")).toBe(true);
  });

  it("N 次 apply 不产生重复元素（Y.Map key 唯一）", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 5; i++) {
      applyTimelineToDoc(doc, makeTimeline());
    }

    const teMap = doc.getMap("trackElementOrderMaps");
    const t1OrderMap = teMap.get("t1") as Y.Map<number>;
    expect(t1OrderMap.size).toBe(2);

    const t2OrderMap = teMap.get("t2") as Y.Map<number>;
    expect(t2OrderMap.size).toBe(1);
    expect(t2OrderMap.has("e3")).toBe(true);
  });

  it("trackElementOrderMaps 的顺序正确（position 排序）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const teMap = doc.getMap("trackElementOrderMaps");
    const t1OrderMap = teMap.get("t1") as Y.Map<number>;

    // 验证 position 值：e1=0, e2=1
    expect(t1OrderMap.get("e1")).toBe(0);
    expect(t1OrderMap.get("e2")).toBe(1);
  });
});

// ─── VID-001b: trackOrderMap（Y.Map）正确写入 ─────────────

describe("VID-001b: trackOrderMap 正确填充", () => {
  it("applyTimelineToDoc 后 trackOrderMap 包含正确的 track IDs", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.has("t1")).toBe(true);
    expect(trackOrderMap.has("t2")).toBe(true);
    expect(trackOrderMap.size).toBe(2);
  });

  it("N 次 apply trackOrderMap 不翻倍（Y.Map key 唯一）", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 5; i++) {
      applyTimelineToDoc(doc, makeTimeline());
    }

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);
  });

  it("trackOrderMap position 顺序正确", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.get("t1")).toBe(0);
    expect(trackOrderMap.get("t2")).toBe(1);
  });
});

// ─── VID-002: sceneTracks Y.Array 复用 ───────────────────

describe("VID-002: applyTimelineToDoc 复用 sceneTracks Y.Array", () => {
  it("二次 apply 后 sceneTracks Y.Array 实例不变", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const stMap = doc.getMap("sceneTracks");
    const s1ArrayBefore = stMap.get("scene-1") as Y.Array<string>;
    expect(s1ArrayBefore).toBeInstanceOf(Y.Array);

    applyTimelineToDoc(doc, makeTimeline());

    const s1ArrayAfter = stMap.get("scene-1") as Y.Array<string>;
    expect(s1ArrayAfter).toBe(s1ArrayBefore);
  });

  it("多场景 N 次 apply 不产生重复 trackId", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 5; i++) {
      applyTimelineToDoc(doc, makeMultiSceneTimeline());
    }

    const stMap = doc.getMap("sceneTracks");
    const s1Array = stMap.get("s1") as Y.Array<string>;
    expect(s1Array.toArray()).toEqual(["t1"]);
    const s2Array = stMap.get("s2") as Y.Array<string>;
    expect(s2Array.toArray()).toEqual(["t2"]);
  });

  it("sceneOrderMap 正确填充", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeMultiSceneTimeline());

    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(sceneOrderMap.has("s1")).toBe(true);
    expect(sceneOrderMap.has("s2")).toBe(true);
    expect(sceneOrderMap.size).toBe(2);
    expect(sceneOrderMap.get("s1")).toBe(0);
    expect(sceneOrderMap.get("s2")).toBe(1);
  });
});

// ─── VID-003: prepareYDocForMerge 不再清空（Y.Map 天然幂等） ─

describe("VID-003: prepareYDocForMerge 后 applyTimelineToDoc 数据正确", () => {
  it("prepareYDocForMerge 后再 apply，trackOrderMap 数据正确无翻倍", () => {
    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);

    (db as unknown as { prepareYDocForMerge: (d: Y.Doc) => void }).prepareYDocForMerge(doc);

    // prepareYDocForMerge 是 no-op，Y.Map 不被清空
    expect(trackOrderMap.size).toBe(2);

    applyTimelineToDoc(doc, makeTimeline());

    // setOrderedIds 覆盖 Y.Map，结果仍然正确
    expect(trackOrderMap.size).toBe(2);
    expect(trackOrderMap.get("t1")).toBe(0);
    expect(trackOrderMap.get("t2")).toBe(1);
  });

  it("多轮 prepare+apply 循环不产生数据翻倍", () => {
    const db = new VideoDatabase();
    const doc = new Y.Doc();

    for (let i = 0; i < 5; i++) {
      (db as unknown as { prepareYDocForMerge: (d: Y.Doc) => void }).prepareYDocForMerge(doc);
      applyTimelineToDoc(doc, makeTimeline());
    }

    const teMap = doc.getMap("trackElementOrderMaps");
    const t1OrderMap = teMap.get("t1") as Y.Map<number>;
    expect(t1OrderMap.size).toBe(2);
    expect(t1OrderMap.get("e1")).toBe(0);
    expect(t1OrderMap.get("e2")).toBe(1);
  });

  it("prepareYDocForMerge 后多场景 apply 正确", () => {
    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeMultiSceneTimeline());

    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(sceneOrderMap.size).toBe(2);

    (db as unknown as { prepareYDocForMerge: (d: Y.Doc) => void }).prepareYDocForMerge(doc);

    applyTimelineToDoc(doc, makeMultiSceneTimeline());

    expect(sceneOrderMap.size).toBe(2);
    expect(sceneOrderMap.get("s1")).toBe(0);
    expect(sceneOrderMap.get("s2")).toBe(1);
  });
});

// ─── VID-004: docToTimeline 读取 Y.Map ────────────────────

describe("VID-004: docToTimeline 从 trackOrderMap/sceneOrderMap 读取", () => {
  it("单场景：docToTimeline 正确从 trackOrderMap 读取 track 顺序", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    const tracks = (scenes[0] as Record<string, unknown>).tracks as Record<string, unknown>[];
    const trackIds = tracks.map((t) => (t as Record<string, unknown>).id);
    expect(trackIds).toEqual(["t1", "t2"]);
  });

  it("多场景：docToTimeline 正确从 sceneOrderMap 读取 scene 顺序", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeMultiSceneTimeline());

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    const sceneIds = scenes.map((s) => (s as Record<string, unknown>).id);
    expect(sceneIds).toEqual(["s1", "s2"]);
  });

  it("element 顺序正确（从 trackElementOrderMaps 读取）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    const tracks = (scenes[0] as Record<string, unknown>).tracks as Record<string, unknown>[];
    const elements = (tracks[0] as Record<string, unknown>).elements as Record<string, unknown>[];
    const elementIds = elements.map((e) => (e as Record<string, unknown>).id);
    expect(elementIds).toEqual(["e1", "e2"]);
  });

  it("fallback: 旧文档（只有 Y.Array）能正确读取", () => {
    const doc = new Y.Doc();
    // 直接写入旧 Y.Array（模拟旧文档）
    doc.transact(() => {
      doc.getMap("tracks").set("t1", { id: "t1", type: "video", name: "V1" });
      doc.getArray<string>("trackOrder").push(["t1"]);
      doc.getMap("meta").set("currentSceneId", "main");
      doc.getMap("meta").set("sceneName", "Old Scene");
      doc.getMap("meta").set("updatedAt", "2026-01-01T00:00:00Z");
      const elMap = new Y.Map<unknown>();
      elMap.set("id", "e1");
      elMap.set("type", "video");
      doc.getMap("elements").set("e1", elMap);
      const order = new Y.Array<string>();
      order.push(["e1"]);
      doc.getMap("trackElements").set("t1", order);
    });

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    expect((scenes[0] as Record<string, unknown>).name).toBe("Old Scene");
    const tracks = (scenes[0] as Record<string, unknown>).tracks as Record<string, unknown>[];
    expect(tracks).toHaveLength(1);
    expect((tracks[0] as Record<string, unknown>).id).toBe("t1");
    const elements = (tracks[0] as Record<string, unknown>).elements as Record<string, unknown>[];
    expect(elements).toHaveLength(1);
    expect((elements[0] as Record<string, unknown>).id).toBe("e1");
  });
});

// ─── VID-005: applyTimelineToDoc 写入 meta.sceneName ──────

describe("VID-005: applyTimelineToDoc 始终写入 meta.sceneName", () => {
  it("单场景时 meta.sceneName 被正确写入", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const meta = doc.getMap("meta");
    expect(meta.get("sceneName")).toBe("Main");
  });

  it("多场景时 meta.sceneName 取首个场景名", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeMultiSceneTimeline());

    const meta = doc.getMap("meta");
    expect(meta.get("sceneName")).toBe("Scene A");
  });

  it("docToTimeline 单场景路径读到正确 sceneName", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap("tracks").set("t1", { id: "t1", type: "video", name: "V1" });
      doc.getMap("trackOrderMap").set("t1", 0);
      doc.getMap("meta").set("currentSceneId", "main");
      doc.getMap("meta").set("sceneName", "Custom Name");
      doc.getMap("meta").set("updatedAt", "2026-01-01T00:00:00Z");
      const elMap = new Y.Map<unknown>();
      elMap.set("id", "e1");
      elMap.set("type", "video");
      doc.getMap("elements").set("e1", elMap);
      const elOrderMap = new Y.Map<number>();
      elOrderMap.set("e1", 0);
      doc.getMap("trackElementOrderMaps").set("t1", elOrderMap);
    });

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    expect((scenes[0] as Record<string, unknown>).name).toBe("Custom Name");
  });
});

// ─── VID-006: mergeTimelineIntoDoc 始终更新 meta.sceneName ─

describe("VID-006: mergeTimelineIntoDoc 始终同步 meta.sceneName", () => {
  it("多场景 merge 后 meta.sceneName 被更新", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const meta = doc.getMap("meta");
    expect(meta.get("sceneName")).toBe("Main");

    mergeTimelineIntoDoc(doc, makeMultiSceneTimeline(), makeTimeline());

    expect(meta.get("sceneName")).toBe("Scene A");
  });

  it("多→单场景降级后 meta.sceneName 保持正确", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeMultiSceneTimeline());

    const meta = doc.getMap("meta");
    expect(meta.get("sceneName")).toBe("Scene A");

    const singleScene = makeTimeline({
      scenes: [{
        id: "s-new",
        name: "Downgraded Scene",
        isMain: true,
        tracks: [{ id: "t1", type: "video", name: "V1", elements: [] }],
      }],
    });

    mergeTimelineIntoDoc(doc, singleScene, makeMultiSceneTimeline());

    expect(meta.get("sceneName")).toBe("Downgraded Scene");
  });

  it("空 scenes push 不改变 meta.sceneName", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const meta = doc.getMap("meta");
    expect(meta.get("sceneName")).toBe("Main");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mergeTimelineIntoDoc(doc, makeTimeline({ scenes: [] }), makeTimeline());
    warnSpy.mockRestore();

    expect(meta.get("sceneName")).toBe("Main");
  });
});

// ─── VID-008: docToTimeline updatedAt 使用稳定值 ──────────

describe("VID-008: docToTimeline updatedAt 从 meta 读取稳定值", () => {
  it("applyTimelineToDoc 写入 meta.updatedAt", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const meta = doc.getMap("meta");
    expect(meta.get("updatedAt")).toBe("2026-01-01T00:00:00Z");
  });

  it("连续两次 docToTimeline 返回相同 updatedAt（digest 稳定）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const result1 = docToTimeline(doc);
    const result2 = docToTimeline(doc);

    const md1 = result1.metadata as Record<string, unknown>;
    const md2 = result2.metadata as Record<string, unknown>;
    expect(md1.updatedAt).toBe(md2.updatedAt);
  });

  it("无变更时 buildPersistPayload 返回 null（digest 正确工作）", () => {
    vi.useFakeTimers({ now: new Date("2026-03-18T00:00:00.000Z") });

    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:vid008-digest-test";
    (db as unknown as { onSnapshotLoaded: (n: string, d: Y.Doc) => void }).onSnapshotLoaded(docName, doc);

    const payload = (db as unknown as { buildPersistPayload: (d: Y.Doc, n: string, c: Record<string, unknown>) => unknown }).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();

    vi.useRealTimers();
  });

  it("有变更时 buildPersistPayload 返回 payload", () => {
    vi.useFakeTimers({ now: new Date("2026-03-18T00:00:00.000Z") });

    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:vid008-changed";
    (db as unknown as { onSnapshotLoaded: (n: string, d: Y.Doc) => void }).onSnapshotLoaded(docName, doc);

    doc.getMap("meta").set("name", "Changed Name");

    const payload = (db as unknown as { buildPersistPayload: (d: Y.Doc, n: string, c: Record<string, unknown>) => unknown }).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    vi.useRealTimers();
  });

  it("JSON.stringify 比较在无变更时产生相同摘要", () => {
    vi.useFakeTimers({ now: new Date("2026-03-18T00:00:00.000Z") });

    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const result1 = JSON.stringify(docToTimeline(doc));
    const result2 = JSON.stringify(docToTimeline(doc));
    expect(result1).toBe(result2);

    vi.useRealTimers();
  });
});

// ─── M03 新增：Y.Map 迁移专属测试 ─────────────────────────

describe("M03: Y.Array→Y.Map 迁移——trackOrderMap/sceneOrderMap 核心验证", () => {
  it("并发写同一 trackId 不产生翻倍（LWW 语义）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    // 模拟两个客户端并发写同一 track 的 position
    doc.transact(() => {
      doc.getMap<number>("trackOrderMap").set("t1", 99);
    });
    doc.transact(() => {
      doc.getMap<number>("trackOrderMap").set("t1", 0);
    });

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    // 无论哪个 LWW 胜出，t1 只有一个 key（不翻倍）
    expect(trackOrderMap.size).toBe(2);
    expect(trackOrderMap.has("t1")).toBe(true);
  });

  it("mergeTimelineIntoDoc 新增 track 时同步写入 trackOrderMap", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const newTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1", elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }] },
          { id: "t2", type: "audio", name: "Audio 1", elements: [{ id: "e3", type: "audio", startTime: 0, duration: 10 }] },
          { id: "t3", type: "text", name: "Text 1", elements: [] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, newTimeline, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.has("t3")).toBe(true);
    expect(trackOrderMap.size).toBe(3);
  });

  it("mergeTimelineIntoDoc 删除 track 时同步从 trackOrderMap 删除", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const reducedTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1", elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, reducedTimeline, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.has("t1")).toBe(true);
    expect(trackOrderMap.has("t2")).toBe(false);
    expect(trackOrderMap.size).toBe(1);
  });

  it("mergeTimelineIntoDoc 新增 element 时同步写入 trackElementOrderMaps", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const newTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          {
            id: "t1",
            type: "video",
            name: "Video 1",
            elements: [
              { id: "e1", type: "video", startTime: 0, duration: 5 },
              { id: "e2", type: "text", startTime: 2, duration: 3 },
              { id: "e4", type: "image", startTime: 4, duration: 2 },
            ],
          },
          { id: "t2", type: "audio", name: "Audio 1", elements: [{ id: "e3", type: "audio", startTime: 0, duration: 10 }] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, newTimeline, makeTimeline());

    const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
    const t1Map = trackElementOrderMaps.get("t1") as Y.Map<number>;
    expect(t1Map.has("e4")).toBe(true);
    expect(t1Map.size).toBe(3);
  });

  it("docToTimeline 在 Y.Map 存在时不使用 Y.Array fallback", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    // 写入错误数据到旧 Y.Array（如果 docToTimeline 用了 fallback 会读错）
    doc.transact(() => {
      doc.getArray<string>("trackOrder").push(["ghost-track"]);
    });

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    const tracks = (scenes[0] as Record<string, unknown>).tracks as Record<string, unknown>[];
    const trackIds = tracks.map((t) => (t as Record<string, unknown>).id);

    // 应该用 trackOrderMap（无 ghost-track），不用旧 Y.Array
    expect(trackIds).not.toContain("ghost-track");
    expect(trackIds).toEqual(["t1", "t2"]);
  });

  it("applyTimelineToDoc 清空旧 track 后 trackOrderMap 正确更新", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);

    // 应用一个只有 t1 的新 timeline
    const reducedTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1", elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }] },
        ],
      }],
    });
    applyTimelineToDoc(doc, reducedTimeline);

    expect(trackOrderMap.size).toBe(1);
    expect(trackOrderMap.has("t1")).toBe(true);
    expect(trackOrderMap.has("t2")).toBe(false);
  });
});
