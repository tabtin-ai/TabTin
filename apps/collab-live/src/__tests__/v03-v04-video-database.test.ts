/**
 * V-03 / V-04 回归测试：video-database.ts 的批量删除与字段级合并
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Y from "yjs";

// 直接导入被测函数
import {
  applyTimelineToDoc,
  mergeTimelineIntoDoc,
  docToTimeline,
  clearSubtitleTracksInDoc,
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
            ],
          },
          {
            id: "t2",
            type: "audio",
            name: "Audio 1",
            elements: [],
          },
        ],
      },
    ],
    currentSceneId: "scene-1",
    version: 1,
    ...overrides,
  };
}

function orderedIds(map: Y.Map<number> | undefined): string[] {
  if (!(map instanceof Y.Map)) return [];
  const entries: [string, number][] = [];
  map.forEach((pos, id) => entries.push([id, pos]));
  entries.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  return entries.map(([id]) => id);
}

// ─── V-03: Y.Map 写入幂等性（迁移后替代旧 Y.Array 批量清空测试） ────

describe("V-03: trackOrderMap/sceneOrderMap Y.Map 写入幂等性", () => {
  it("N 次 applyTimelineToDoc 后 trackOrderMap 不翻倍（Y.Map key 唯一）", () => {
    const doc = new Y.Doc();
    for (let i = 0; i < 3; i++) {
      applyTimelineToDoc(doc, makeTimeline());
    }

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);
    expect(trackOrderMap.has("t1")).toBe(true);
    expect(trackOrderMap.has("t2")).toBe(true);
  });

  it("N 次 applyTimelineToDoc 后 sceneOrderMap 不翻倍", () => {
    const doc = new Y.Doc();
    const multiScene = makeTimeline({
      scenes: [
        { id: "s1", name: "Scene 1", isMain: true, tracks: [] },
        { id: "s2", name: "Scene 2", isMain: false, tracks: [] },
      ],
    });
    for (let i = 0; i < 3; i++) {
      applyTimelineToDoc(doc, multiScene);
    }

    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(sceneOrderMap.size).toBe(2);
    expect(sceneOrderMap.has("s1")).toBe(true);
    expect(sceneOrderMap.has("s2")).toBe(true);
  });
});

// ─── V-04: Settings/Meta 字段级合并 ────────────────────

describe("V-04: mergeTimelineIntoDoc 字段级 settings 合并", () => {
  it("Agent push 不覆盖用户本地修改的 fps", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const settingsMap = doc.getMap("settings");
    settingsMap.set("fps", 60);

    const agentTimeline = makeTimeline({
      settings: {
        fps: 30,
        canvasSize: { width: 1920, height: 1080 },
        background: { type: "color", color: "#ffffff" },
      },
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(settingsMap.get("fps")).toBe(60);
    expect(settingsMap.get("bgColor")).toBe("#ffffff");
  });

  it("Agent push 不覆盖用户本地修改的画布尺寸", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const settingsMap = doc.getMap("settings");
    settingsMap.set("width", 3840);
    settingsMap.set("height", 2160);

    const agentTimeline = makeTimeline({
      settings: {
        fps: 30,
        canvasSize: { width: 1920, height: 1080 },
        background: { type: "color", color: "#000000" },
      },
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(settingsMap.get("width")).toBe(3840);
    expect(settingsMap.get("height")).toBe(2160);
  });

  it("Agent 实际修改的字段会正确更新", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const agentTimeline = makeTimeline({
      settings: {
        fps: 24,
        canvasSize: { width: 3840, height: 2160 },
        background: { type: "color", color: "#111111" },
      },
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const settingsMap = doc.getMap("settings");
    expect(settingsMap.get("fps")).toBe(24);
    expect(settingsMap.get("width")).toBe(3840);
    expect(settingsMap.get("height")).toBe(2160);
    expect(settingsMap.get("bgColor")).toBe("#111111");
  });

  it("无 baseTimeline 时回退到全覆盖（向后兼容）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const settingsMap = doc.getMap("settings");
    settingsMap.set("fps", 60);

    const agentTimeline = makeTimeline({
      settings: {
        fps: 30,
        canvasSize: { width: 1920, height: 1080 },
        background: { type: "color", color: "#000000" },
      },
    });

    mergeTimelineIntoDoc(doc, agentTimeline, undefined);

    expect(settingsMap.get("fps")).toBe(30);
  });

  it("Meta 字段级合并：Agent 不覆盖用户修改的 name", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const meta = doc.getMap("meta");
    meta.set("name", "User Renamed");

    const agentTimeline = makeTimeline();
    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(meta.get("name")).toBe("User Renamed");
  });
});

// ─── W3-14: 空 scenes 防护 ────────────────────────────────

describe("W3-14: mergeTimelineIntoDoc 空 scenes 不清空已有轨道", () => {
  it("空 scenes 数组不删除已有轨道和元素", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    const tracksMap = doc.getMap("tracks");
    const elementsMap = doc.getMap("elements");
    expect(trackOrderMap.size).toBe(2);
    expect(tracksMap.size).toBe(2);
    expect(elementsMap.size).toBe(1);

    const emptyPush = makeTimeline({ scenes: [] });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mergeTimelineIntoDoc(doc, emptyPush, base);
    warnSpy.mockRestore();

    expect(trackOrderMap.size).toBe(2);
    expect(tracksMap.size).toBe(2);
    expect(elementsMap.size).toBe(1);
  });

  it("空 scenes 数组触发 warning 日志", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emptyPush = makeTimeline({ scenes: [] });
    mergeTimelineIntoDoc(doc, emptyPush, makeTimeline());

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("skipping orphan cleanup"),
    );
    warnSpy.mockRestore();
  });

  it("正常 scenes push 仍能清理孤立轨道", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);

    const partialPush = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{ id: "t1", type: "video", name: "Video 1", elements: [] }],
      }],
    });
    mergeTimelineIntoDoc(doc, partialPush, makeTimeline());

    expect(trackOrderMap.size).toBe(1);
    expect(trackOrderMap.has("t1")).toBe(true);
    expect(trackOrderMap.has("t2")).toBe(false);
    expect(doc.getMap("tracks").has("t2")).toBe(false);
  });

  it("doc 无已有轨道时空 scenes 不触发 warning", () => {
    const doc = new Y.Doc();

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const emptyPush = makeTimeline({ scenes: [] });
    mergeTimelineIntoDoc(doc, emptyPush, makeTimeline());

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── CI-001 回归：Video 首次 store 不再丢弃数据 ──────────

describe("CI-001: Video buildPersistPayload 首次 store 必须返回 payload", () => {
  let db: VideoDatabase;

  beforeEach(() => {
    db = new VideoDatabase();
  });

  it("无 lastSnapshot 时 buildPersistPayload 返回非 null payload（全量持久化）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:ci001-test";
    // 不调用 onSnapshotLoaded → snapshotCache 为空

    const payload = (db as any).buildPersistPayload(doc, docName, {});

    expect(payload).not.toBeNull();
    expect(payload.changes).toHaveProperty("timeline_data");
    expect(payload.changes.timeline_data).toHaveProperty("scenes");
  });

  it("无 lastSnapshot 时 buildPersistPayload 不产生 snapshotCache 副作用", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:ci001-no-side-effect";

    (db as any).buildPersistPayload(doc, docName, {});

    expect(db.snapshotCache.has(docName)).toBe(false);
  });

  it("onStoreSuccess 后再次 buildPersistPayload 返回 null（无变更）", () => {
    const fixedDate = new Date("2026-03-18T00:00:00.000Z");
    vi.useFakeTimers({ now: fixedDate });

    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:ci001-success-flow";

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();

    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).toBeNull();

    vi.useRealTimers();
  });

  it("有 lastSnapshot 且数据一致时返回 null", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:ci001-no-change";
    (db as any).onSnapshotLoaded(docName, doc);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();
  });
});

// ─── VSC-018: baseTrackMap 提升到循环外（O(S²T²) → O(ST)）─

describe("VSC-018: mergeTimelineIntoDoc baseTrackMap hoisted outside loop", () => {
  it("三方合并仍正确更新被 Agent 修改的轨道元数据", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Renamed Video", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
          ]},
          { id: "t2", type: "audio", name: "Audio 1", elements: [] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const trackMeta = doc.getMap("tracks").get("t1") as Record<string, unknown>;
    expect(trackMeta.name).toBe("Renamed Video");
  });

  it("多场景多轨道三方合并行为正确", () => {
    const multiSceneTimeline = {
      ...makeTimeline(),
      scenes: [
        {
          id: "s1", name: "Scene 1", isMain: true,
          tracks: [
            { id: "t1", type: "video", name: "V1", elements: [] },
            { id: "t2", type: "audio", name: "A1", elements: [] },
          ],
        },
        {
          id: "s2", name: "Scene 2", isMain: false,
          tracks: [
            { id: "t3", type: "video", name: "V2", elements: [] },
            { id: "t4", type: "text", name: "T1", elements: [] },
          ],
        },
      ],
    };

    const doc = new Y.Doc();
    applyTimelineToDoc(doc, multiSceneTimeline);

    const agentTimeline = {
      ...multiSceneTimeline,
      scenes: [
        {
          id: "s1", name: "Scene 1", isMain: true,
          tracks: [
            { id: "t1", type: "video", name: "V1-renamed", elements: [] },
            { id: "t2", type: "audio", name: "A1", elements: [] },
          ],
        },
        {
          id: "s2", name: "Scene 2", isMain: false,
          tracks: [
            { id: "t3", type: "video", name: "V2", elements: [] },
            { id: "t4", type: "text", name: "T1-renamed", elements: [] },
          ],
        },
      ],
    };

    mergeTimelineIntoDoc(doc, agentTimeline, multiSceneTimeline);

    const tracks = doc.getMap("tracks");
    expect((tracks.get("t1") as Record<string, unknown>).name).toBe("V1-renamed");
    expect((tracks.get("t2") as Record<string, unknown>).name).toBe("A1");
    expect((tracks.get("t3") as Record<string, unknown>).name).toBe("V2");
    expect((tracks.get("t4") as Record<string, unknown>).name).toBe("T1-renamed");
  });

  it("用户并发修改的轨道名不被 Agent 覆盖（三方合并语义）", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.getMap("tracks").set("t1", { id: "t1", type: "video", name: "User Edited" });

    const agentTimeline = makeTimeline();
    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const trackMeta = doc.getMap("tracks").get("t1") as Record<string, unknown>;
    expect(trackMeta.name).toBe("User Edited");
  });

  it("单场景 sceneName 不被仅刷新素材引用的 Agent push 覆盖", () => {
    const base = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/old.mp4",
              mediaPropsHash: "hash-old",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.getMap("meta").set("sceneName", "User Renamed Scene");

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/new.mp4",
              mediaPropsHash: "hash-new",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base, {
      forceResyncMediaRefs: { mediaIds: ["clip-1"] },
    });

    expect(doc.getMap("meta").get("sceneName")).toBe("User Renamed Scene");
    const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
    expect(e1.get("fileUrl")).toBe("https://cdn.example.com/new.mp4");
    expect(e1.get("mediaPropsHash")).toBe("hash-new");
  });

  it("多场景 scenesMap.name/isMain 不被仅刷新素材引用的 Agent push 覆盖", () => {
    const base = makeTimeline({
      scenes: [
        {
          id: "s1", name: "Scene 1", isMain: true,
          tracks: [{
            id: "t1", type: "video", name: "V1", elements: [
              {
                id: "e1",
                type: "video",
                mediaId: "clip-1",
                fileUrl: "https://cdn.example.com/old.mp4",
                mediaPropsHash: "hash-old",
                startTime: 0,
                duration: 5,
              },
            ],
          }],
        },
        {
          id: "s2", name: "Scene 2", isMain: false,
          tracks: [{ id: "t2", type: "video", name: "V2", elements: [] }],
        },
      ],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      const scenesMap = doc.getMap("scenes");
      scenesMap.set("s1", {
        ...(scenesMap.get("s1") as Record<string, unknown>),
        name: "User Scene 1",
      });
      scenesMap.set("s2", {
        ...(scenesMap.get("s2") as Record<string, unknown>),
        isMain: true,
      });
    });

    const agentTimeline = makeTimeline({
      scenes: [
        {
          id: "s1", name: "Scene 1", isMain: true,
          tracks: [{
            id: "t1", type: "video", name: "V1", elements: [
              {
                id: "e1",
                type: "video",
                mediaId: "clip-1",
                fileUrl: "https://cdn.example.com/new.mp4",
                mediaPropsHash: "hash-new",
                startTime: 0,
                duration: 5,
              },
            ],
          }],
        },
        {
          id: "s2", name: "Scene 2", isMain: false,
          tracks: [{ id: "t2", type: "video", name: "V2", elements: [] }],
        },
      ],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base, {
      forceResyncMediaRefs: { mediaIds: ["clip-1"] },
    });

    const scenesMap = doc.getMap("scenes");
    expect((scenesMap.get("s1") as Record<string, unknown>).name).toBe("User Scene 1");
    expect((scenesMap.get("s2") as Record<string, unknown>).isMain).toBe(true);
    const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
    expect(e1.get("fileUrl")).toBe("https://cdn.example.com/new.mp4");
    expect(e1.get("mediaPropsHash")).toBe("hash-new");
  });

  it("Agent push 不删除 base 之后 live 新增的轨道、场景和元素", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").set("t-live", { id: "t-live", type: "video", name: "Live Track" });
      doc.getMap<number>("trackOrderMap").set("t-live", 2);

      const liveEl = new Y.Map<unknown>();
      liveEl.set("id", "e-live");
      liveEl.set("type", "video");
      liveEl.set("startTime", 6);
      liveEl.set("duration", 2);
      doc.getMap("elements").set("e-live", liveEl);
      const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
      t1Order.set("e-live", 1);

      doc.getMap("scenes").set("scene-live", { id: "scene-live", name: "Live Scene", isMain: false });
      doc.getMap<number>("sceneOrderMap").set("scene-live", 1);
      const sceneTracks = new Y.Array<string>();
      sceneTracks.push(["t-live"]);
      doc.getMap("sceneTracks").set("scene-live", sceneTracks);
    });

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1 Updated", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
          ]},
          { id: "t2", type: "audio", name: "Audio 1", elements: [] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(doc.getMap("tracks").has("t-live")).toBe(true);
    expect(doc.getMap("scenes").has("scene-live")).toBe(true);
    expect(doc.getMap("elements").has("e-live")).toBe(true);
    expect(doc.getMap<number>("trackOrderMap").has("t-live")).toBe(true);
    expect(doc.getMap<number>("sceneOrderMap").has("scene-live")).toBe(true);
  });

  it("Agent 删除 base 中已有元素时同步删除，同时保留 live 并发新增元素", () => {
    const base = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
            { id: "e2", type: "video", startTime: 5, duration: 3 },
          ],
        }],
      }],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      const liveEl = new Y.Map<unknown>();
      liveEl.set("id", "e-live");
      liveEl.set("type", "video");
      liveEl.set("startTime", 8);
      liveEl.set("duration", 2);
      doc.getMap("elements").set("e-live", liveEl);
      const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
      t1Order.set("e-live", 2);
    });

    const agentTimeline = {
      ...base,
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
          ],
        }],
      }],
    };

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(doc.getMap("elements").has("e1")).toBe(true);
    expect(doc.getMap("elements").has("e2")).toBe(false);
    expect(doc.getMap("elements").has("e-live")).toBe(true);
    const order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
    expect(order.has("e2")).toBe(false);
    expect(order.has("e-live")).toBe(true);
  });

  it("用户并发删除 base 元素后，旧 Agent payload 不复活该元素", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("elements").delete("e1");
      const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
      t1Order.delete("e1");
    });

    mergeTimelineIntoDoc(doc, base, base);

    expect(doc.getMap("elements").has("e1")).toBe(false);
    const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
    expect(t1Order.has("e1")).toBe(false);
  });

  it("用户并发移动 base 元素到 live 轨道后，旧 Agent payload 不写回旧轨道", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").set("t-live", { id: "t-live", type: "video", name: "Live Track" });
      doc.getMap<number>("trackOrderMap").set("t-live", 2);

      const sceneTracks = doc.getMap("sceneTracks").get("scene-1") as Y.Array<string>;
      sceneTracks.push(["t-live"]);

      const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
      t1Order.delete("e1");
      const liveOrder = new Y.Map<number>();
      liveOrder.set("e1", 0);
      doc.getMap("trackElementOrderMaps").set("t-live", liveOrder);
    });

    mergeTimelineIntoDoc(doc, base, base);

    const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
    const liveOrder = doc.getMap("trackElementOrderMaps").get("t-live") as Y.Map<number>;
    expect(t1Order.has("e1")).toBe(false);
    expect(liveOrder.has("e1")).toBe(true);
    expect(doc.getMap("elements").has("e1")).toBe(true);
  });

  it("用户并发删除 base 轨道后，旧 Agent payload 不复活轨道和元素", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").delete("t1");
      doc.getMap<number>("trackOrderMap").delete("t1");
      doc.getMap("trackElementOrderMaps").delete("t1");
      doc.getMap("elements").delete("e1");
      const sceneTracks = doc.getMap("sceneTracks").get("scene-1") as Y.Array<string>;
      for (let i = sceneTracks.length - 1; i >= 0; i--) {
        if (sceneTracks.get(i) === "t1") sceneTracks.delete(i, 1);
      }
    });

    mergeTimelineIntoDoc(doc, base, base);

    expect(doc.getMap("tracks").has("t1")).toBe(false);
    expect(doc.getMap("elements").has("e1")).toBe(false);
    expect(doc.getMap<number>("trackOrderMap").has("t1")).toBe(false);
    const sceneTracks = doc.getMap("sceneTracks").get("scene-1") as Y.Array<string>;
    expect(sceneTracks.toArray()).not.toContain("t1");
  });

  it("用户并发删除 base 场景后，旧 Agent payload 不复活场景外壳", () => {
    const base = makeTimeline({
      scenes: [
        {
          id: "scene-1", name: "Main", isMain: true,
          tracks: [{ id: "t1", type: "video", name: "Video 1", elements: [] }],
        },
        {
          id: "scene-2", name: "Second", isMain: false,
          tracks: [{
            id: "t3",
            type: "video",
            name: "Video 3",
            elements: [{ id: "e3", type: "video", startTime: 0, duration: 2 }],
          }],
        },
      ],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("scenes").delete("scene-2");
      doc.getMap<number>("sceneOrderMap").delete("scene-2");
      doc.getMap("sceneTracks").delete("scene-2");
      doc.getMap("tracks").delete("t3");
      doc.getMap<number>("trackOrderMap").delete("t3");
      doc.getMap("trackElementOrderMaps").delete("t3");
      doc.getMap("elements").delete("e3");
    });

    mergeTimelineIntoDoc(doc, base, base);

    expect(doc.getMap("scenes").has("scene-2")).toBe(false);
    expect(doc.getMap<number>("sceneOrderMap").has("scene-2")).toBe(false);
    expect(doc.getMap("sceneTracks").has("scene-2")).toBe(false);
    expect(doc.getMap("tracks").has("t3")).toBe(false);
    expect(doc.getMap("elements").has("e3")).toBe(false);
  });

  it("Agent 删除 base 场景时保留已被 live 改动的 scene 及其内容", () => {
    const base = makeTimeline({
      scenes: [
        {
          id: "scene-1", name: "Main", isMain: true,
          tracks: [{ id: "t1", type: "video", name: "Video 1", elements: [] }],
        },
        {
          id: "scene-2", name: "Second", isMain: false,
          tracks: [{
            id: "t3",
            type: "video",
            name: "Video 3",
            elements: [{ id: "e3", type: "video", startTime: 0, duration: 2 }],
          }],
        },
      ],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("scenes").set("scene-2", {
        id: "scene-2",
        name: "Live Renamed",
        isMain: false,
        bookmarks: [{ time: 12, note: "keep" }],
      });
      doc.getMap("tracks").set("t-live", { id: "t-live", type: "audio", name: "Live Track" });
      doc.getMap<number>("trackOrderMap").set("t-live", 2);
      const sceneTracks = doc.getMap("sceneTracks").get("scene-2") as Y.Array<string>;
      sceneTracks.push(["t-live"]);
      const liveOrder = new Y.Map<number>();
      doc.getMap("trackElementOrderMaps").set("t-live", liveOrder);
    });

    const agentTimeline = makeTimeline({
      scenes: [
        {
          id: "scene-1", name: "Main", isMain: true,
          tracks: [{ id: "t1", type: "video", name: "Video 1", elements: [] }],
        },
      ],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    expect(doc.getMap("scenes").has("scene-2")).toBe(true);
    expect((doc.getMap("scenes").get("scene-2") as Record<string, unknown>).name).toBe("Live Renamed");
    expect(doc.getMap("tracks").has("t3")).toBe(true);
    expect(doc.getMap("tracks").has("t-live")).toBe(true);
    const sceneTracks = doc.getMap("sceneTracks").get("scene-2") as Y.Array<string>;
    expect(sceneTracks.toArray()).toEqual(["t3", "t-live"]);
    expect(doc.getMap("elements").has("e3")).toBe(true);
  });

  it("force resync media refs 在 base==new 时刷新旧 fileUrl/hash，并刷新 live 新增同 mediaId 元素", () => {
    const base = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/current.mp4",
              mediaPropsHash: "hash-current",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
      e1.set("fileUrl", "https://cdn.example.com/stale.mp4");
      e1.set("mediaPropsHash", "hash-stale");

      doc.getMap("tracks").set("t-live", { id: "t-live", type: "video", name: "Live Track" });
      doc.getMap<number>("trackOrderMap").set("t-live", 1);
      doc.getMap("scenes").set("scene-live", { id: "scene-live", name: "Live Scene", isMain: false });
      doc.getMap<number>("sceneOrderMap").set("scene-live", 1);
      const sceneTracks = new Y.Array<string>();
      sceneTracks.push(["t-live"]);
      doc.getMap("sceneTracks").set("scene-live", sceneTracks);

      const liveEl = new Y.Map<unknown>();
      liveEl.set("id", "e-live");
      liveEl.set("type", "video");
      liveEl.set("mediaId", "clip-1");
      liveEl.set("fileUrl", "https://cdn.example.com/live-stale.mp4");
      liveEl.set("mediaPropsHash", "hash-live-stale");
      liveEl.set("startTime", 6);
      liveEl.set("duration", 2);
      doc.getMap("elements").set("e-live", liveEl);
      const t1Order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
      t1Order.set("e-live", 1);
    });

    mergeTimelineIntoDoc(doc, base, base, {
      forceResyncMediaRefs: { mediaIds: ["clip-1"] },
    });

    const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
    expect(e1.get("fileUrl")).toBe("https://cdn.example.com/current.mp4");
    expect(e1.get("mediaPropsHash")).toBe("hash-current");
    expect(doc.getMap("tracks").has("t-live")).toBe(true);
    expect(doc.getMap("scenes").has("scene-live")).toBe(true);
    expect(doc.getMap("elements").has("e-live")).toBe(true);
    const liveEl = doc.getMap("elements").get("e-live") as Y.Map<unknown>;
    expect(liveEl.get("fileUrl")).toBe("https://cdn.example.com/current.mp4");
    expect(liveEl.get("mediaPropsHash")).toBe("hash-current");
    const order = doc.getMap("trackElementOrderMaps").get("t1") as Y.Map<number>;
    expect(order.has("e-live")).toBe(true);
  });

  it("force resync media refs 在重渲染成功路径刷新 live 新增同 mediaId 元素且保留其余字段", () => {
    const base = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/old.mp4",
              mediaPropsHash: "hash-old",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").set("t-live", { id: "t-live", type: "video", name: "Live Track" });
      doc.getMap<number>("trackOrderMap").set("t-live", 1);
      const sceneTracks = doc.getMap("sceneTracks").get("scene-1") as Y.Array<string>;
      sceneTracks.push(["t-live"]);

      const liveEl = new Y.Map<unknown>();
      liveEl.set("id", "e-live");
      liveEl.set("type", "video");
      liveEl.set("mediaId", "clip-1");
      liveEl.set("fileUrl", "https://cdn.example.com/live-old.mp4");
      liveEl.set("mediaPropsHash", "hash-live-old");
      liveEl.set("startTime", 8);
      liveEl.set("duration", 2);
      liveEl.set("name", "Live copy");
      doc.getMap("elements").set("e-live", liveEl);
      const liveOrder = new Y.Map<number>();
      liveOrder.set("e-live", 0);
      doc.getMap("trackElementOrderMaps").set("t-live", liveOrder);
    });

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/new.mp4",
              mediaPropsHash: "hash-new",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base, {
      forceResyncMediaRefs: { mediaIds: ["clip-1"] },
    });

    const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
    expect(e1.get("fileUrl")).toBe("https://cdn.example.com/new.mp4");
    expect(e1.get("mediaPropsHash")).toBe("hash-new");

    const liveEl = doc.getMap("elements").get("e-live") as Y.Map<unknown>;
    expect(liveEl.get("fileUrl")).toBe("https://cdn.example.com/new.mp4");
    expect(liveEl.get("mediaPropsHash")).toBe("hash-new");
    expect(liveEl.get("startTime")).toBe(8);
    expect(liveEl.get("duration")).toBe(2);
    expect(liveEl.get("name")).toBe("Live copy");
    expect(doc.getMap("tracks").has("t-live")).toBe(true);
    const liveOrder = doc.getMap("trackElementOrderMaps").get("t-live") as Y.Map<number>;
    expect(liveOrder.has("e-live")).toBe(true);
  });

  it("force resync 不把旧 clip 的 fileUrl/hash 写到用户已换素材的元素上", () => {
    const base = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/clip-1-old.mp4",
              mediaPropsHash: "hash-clip-1-old",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
      e1.set("mediaId", "clip-2");
      e1.set("fileUrl", "https://cdn.example.com/clip-2-current.mp4");
      e1.set("mediaPropsHash", "hash-clip-2-current");
    });

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1", elements: [
            {
              id: "e1",
              type: "video",
              mediaId: "clip-1",
              fileUrl: "https://cdn.example.com/clip-1-new.mp4",
              mediaPropsHash: "hash-clip-1-new",
              startTime: 0,
              duration: 5,
            },
          ],
        }],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base, {
      forceResyncMediaRefs: { mediaIds: ["clip-1"] },
    });

    const e1 = doc.getMap("elements").get("e1") as Y.Map<unknown>;
    expect(e1.get("mediaId")).toBe("clip-2");
    expect(e1.get("fileUrl")).toBe("https://cdn.example.com/clip-2-current.mp4");
    expect(e1.get("mediaPropsHash")).toBe("hash-clip-2-current");
  });
});

// ─── VSC-019: onStoreSuccess 复用缓存避免二次 docToTimeline ─

describe("VSC-019: onStoreSuccess reuses cached timeline from buildPersistPayload", () => {
  it("onStoreSuccess 后 snapshotCache 包含正确版本号", () => {
    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:vsc019-version";
    (db as any).onSnapshotLoaded(docName, doc);

    doc.getMap("meta").set("name", "Changed Name");

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).not.toBeNull();

    (db as any).onStoreSuccess(doc, docName, { version: 42 });

    const cached = db.snapshotCache.get(docName) as Record<string, unknown>;
    expect(cached).toBeDefined();
    expect(cached.version).toBe(42);
  });

  it("buildPersistPayload 返回 null 时不留 _pendingTimeline 残余", () => {
    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:vsc019-no-residue";
    (db as any).onSnapshotLoaded(docName, doc);

    const payload = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload).toBeNull();

    expect((db as any)._pendingTimeline.has(docName)).toBe(false);
  });

  it("连续 store 后 snapshotCache 正确更新", () => {
    const db = new VideoDatabase();
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const docName = "video:vsc019-consecutive";

    const payload1 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload1).not.toBeNull();
    (db as any).onStoreSuccess(doc, docName, { version: 1 });

    doc.getMap("meta").set("name", "Second Change");

    const payload2 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload2).not.toBeNull();
    (db as any).onStoreSuccess(doc, docName, { version: 2 });

    const cached = db.snapshotCache.get(docName) as Record<string, unknown>;
    expect(cached.version).toBe(2);

    const payload3 = (db as any).buildPersistPayload(doc, docName, {});
    expect(payload3).toBeNull();
  });
});

// ─── VSC-022: docToTimeline Y.Array toArray() 优化 ────────

describe("VSC-022: docToTimeline uses toArray() instead of sequential get()", () => {
  it("50+ elements 重建结果正确（功能回归）", () => {
    const doc = new Y.Doc();
    const elements = Array.from({ length: 50 }, (_, i) => ({
      id: `e${i}`, type: "video", startTime: i * 2, duration: 1,
    }));
    applyTimelineToDoc(doc, makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{ id: "t1", type: "video", name: "V1", elements }],
      }],
    }));

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    const tracks = scenes[0].tracks as Record<string, unknown>[];
    const resElements = tracks[0].elements as Record<string, unknown>[];

    expect(resElements).toHaveLength(50);
    expect(resElements[0].id).toBe("e0");
    expect(resElements[49].id).toBe("e49");
    expect(resElements[25].startTime).toBe(50);
  });

  it("单场景模式下：旧 Y.Array 文档（fallback）trackOrder 正确读取", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap("tracks").set("t1", { id: "t1", type: "video", name: "V1" });
      doc.getArray<string>("trackOrder").push(["t1"]);
      doc.getMap("meta").set("currentSceneId", "main");
      const elMap = new Y.Map<unknown>();
      elMap.set("id", "e1");
      elMap.set("type", "video");
      doc.getMap("elements").set("e1", elMap);
      const order = new Y.Array<string>();
      order.push(["e1"]);
      doc.getMap("trackElements").set("t1", order);
    });

    // 旧文档没有 trackOrderMap（Y.Map 为空），docToTimeline 走 fallback 路径
    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(0);

    const result = docToTimeline(doc);

    const scenes = result.scenes as Record<string, unknown>[];
    const tracks = scenes[0].tracks as Record<string, unknown>[];
    expect(tracks).toHaveLength(1);
    expect(tracks[0].id).toBe("t1");
  });

  it("多场景 sceneOrderMap 正确驱动 docToTimeline", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline({
      scenes: [
        { id: "s1", name: "Scene 1", isMain: true, tracks: [
          { id: "t1", type: "video", name: "V1", elements: [] },
        ]},
        { id: "s2", name: "Scene 2", isMain: false, tracks: [
          { id: "t2", type: "video", name: "V2", elements: [] },
        ]},
      ],
    }));

    // 迁移后使用 sceneOrderMap（Y.Map），不用旧 Y.Array
    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(sceneOrderMap.size).toBe(2);

    const result = docToTimeline(doc);

    const scenes = result.scenes as Record<string, unknown>[];
    expect(scenes).toHaveLength(2);
    expect(scenes[0].id).toBe("s1");
    expect(scenes[1].id).toBe("s2");
  });
});

// ─── VSC-028: clearSubtitleTracksInDoc toArray() 优化 ──────

describe("VSC-028: clearSubtitleTracksInDoc uses toArray() for element iteration", () => {
  it("清除 text 轨道后只移除 text 轨道，保留其他类型", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "V1", elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5 },
          ]},
          { id: "t-text", type: "text", name: "Subtitle", elements: [
            { id: "sub1", type: "text", startTime: 0, duration: 3 },
            { id: "sub2", type: "text", startTime: 3, duration: 2 },
          ]},
        ],
      }],
    }));

    const removed = clearSubtitleTracksInDoc(doc);

    expect(removed).toBe(2);
    expect(doc.getMap("tracks").has("t1")).toBe(true);
    expect(doc.getMap("tracks").has("t-text")).toBe(false);
    expect(doc.getMap("elements").has("e1")).toBe(true);
    expect(doc.getMap("elements").has("sub1")).toBe(false);
    expect(doc.getMap("elements").has("sub2")).toBe(false);
  });

  it("无 text 轨道时返回 0", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const removed = clearSubtitleTracksInDoc(doc);
    expect(removed).toBe(0);
  });
});

// ─── Wave 3 P1: base-aware membership/delete merge ───────

describe("Wave 3 P1: base-aware track/element membership merge", () => {
  it("Agent 删除 track 时，live track 已改名或新增元素则保留 live track", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").set("t1", {
        id: "t1",
        type: "video",
        name: "User Renamed",
      });

      const liveElement = new Y.Map<unknown>();
      liveElement.set("id", "e-live");
      liveElement.set("type", "video");
      liveElement.set("startTime", 8);
      liveElement.set("duration", 2);
      doc.getMap("elements").set("e-live", liveElement);

      const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
      const t1Order = trackElementOrderMaps.get("t1") as Y.Map<number>;
      t1Order.set("e-live", 1);
    });

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          { id: "t2", type: "audio", name: "Audio 1", elements: [] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const result = docToTimeline(doc);
    const tracks = (result.scenes as Record<string, unknown>[])[0].tracks as Record<string, unknown>[];
    const t1 = tracks.find((track) => track.id === "t1");
    expect(t1).toBeDefined();
    expect(t1?.name).toBe("User Renamed");
    expect((t1?.elements as Record<string, unknown>[]).map((element) => element.id)).toContain("e-live");
  });

  it("Track 跨 scene 移动后只保留新 scene membership，docToTimeline 不重复", () => {
    const doc = new Y.Doc();
    const base = makeTimeline({
      scenes: [
        {
          id: "scene-1",
          name: "Scene 1",
          isMain: true,
          tracks: [{ id: "t1", type: "video", name: "Video 1", elements: [] }],
        },
        {
          id: "scene-2",
          name: "Scene 2",
          isMain: false,
          tracks: [{ id: "t2", type: "audio", name: "Audio 1", elements: [] }],
        },
      ],
      currentSceneId: "scene-1",
    });
    applyTimelineToDoc(doc, base);

    const agentTimeline = makeTimeline({
      scenes: [
        { id: "scene-1", name: "Scene 1", isMain: true, tracks: [] },
        {
          id: "scene-2",
          name: "Scene 2",
          isMain: false,
          tracks: [
            { id: "t2", type: "audio", name: "Audio 1", elements: [] },
            { id: "t1", type: "video", name: "Video 1", elements: [] },
          ],
        },
      ],
      currentSceneId: "scene-2",
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const sceneTracksMap = doc.getMap("sceneTracks");
    expect((sceneTracksMap.get("scene-1") as Y.Array<string>).toArray()).not.toContain("t1");
    expect((sceneTracksMap.get("scene-2") as Y.Array<string>).toArray()).toContain("t1");

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    expect((scenes[0].tracks as Record<string, unknown>[]).map((track) => track.id)).not.toContain("t1");
    expect((scenes[1].tracks as Record<string, unknown>[]).map((track) => track.id)).toContain("t1");
    const allTrackIds = scenes.flatMap((scene) =>
      (scene.tracks as Record<string, unknown>[]).map((track) => track.id),
    );
    expect(allTrackIds.filter((id) => id === "t1")).toHaveLength(1);
  });

  it("Element 跨 track 移动时旧 track 只移除 order membership，不删除全局 element", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          {
            id: "t2",
            type: "audio",
            name: "Audio 1",
            elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }],
          },
          { id: "t1", type: "video", name: "Video 1", elements: [] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
    expect(doc.getMap("elements").has("e1")).toBe(true);
    expect(orderedIds(trackElementOrderMaps.get("t1") as Y.Map<number>)).not.toContain("e1");
    expect(orderedIds(trackElementOrderMaps.get("t2") as Y.Map<number>)).toContain("e1");

    const result = docToTimeline(doc);
    const tracks = (result.scenes as Record<string, unknown>[])[0].tracks as Record<string, unknown>[];
    const occurrences = tracks.flatMap((track) =>
      (track.elements as Record<string, unknown>[]).map((element) => element.id),
    ).filter((id) => id === "e1");
    expect(occurrences).toHaveLength(1);
  });

  it("Agent 与 live 并发移动同一 element 时保留 live membership 且不重复", () => {
    const doc = new Y.Doc();
    const base = makeTimeline();
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").set("t-live", {
        id: "t-live",
        type: "video",
        name: "Live Video",
      });
      doc.getMap<number>("trackOrderMap").set("t-live", 2);

      const sceneTracksMap = doc.getMap("sceneTracks");
      const sceneTracks = sceneTracksMap.get("scene-1") as Y.Array<string>;
      sceneTracks.push(["t-live"]);

      const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
      const t1Order = trackElementOrderMaps.get("t1") as Y.Map<number>;
      t1Order.delete("e1");
      const liveOrder = new Y.Map<number>();
      liveOrder.set("e1", 0);
      trackElementOrderMaps.set("t-live", liveOrder);
    });

    const agentTimeline = makeTimeline({
      scenes: [{
        id: "scene-1",
        name: "Main",
        isMain: true,
        tracks: [
          { id: "t1", type: "video", name: "Video 1", elements: [] },
          {
            id: "t-agent",
            type: "video",
            name: "Agent Video",
            elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }],
          },
          { id: "t2", type: "audio", name: "Audio 1", elements: [] },
        ],
      }],
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
    expect(orderedIds(trackElementOrderMaps.get("t1") as Y.Map<number>)).not.toContain("e1");
    expect(orderedIds(trackElementOrderMaps.get("t-agent") as Y.Map<number>)).not.toContain("e1");
    expect(orderedIds(trackElementOrderMaps.get("t-live") as Y.Map<number>)).toContain("e1");

    const result = docToTimeline(doc);
    const tracks = (result.scenes as Record<string, unknown>[])[0].tracks as Record<string, unknown>[];
    const memberships = tracks.flatMap((track) =>
      (track.elements as Record<string, unknown>[]).map((element) => ({
        trackId: track.id,
        elementId: element.id,
      })),
    ).filter((item) => item.elementId === "e1");
    expect(memberships).toEqual([{ trackId: "t-live", elementId: "e1" }]);
  });

  it("Agent 删除 base element 时保留用户迁移到其他 scene/track 的 live element", () => {
    const doc = new Y.Doc();
    const base = makeTimeline({
      scenes: [
        {
          id: "scene-1",
          name: "Scene 1",
          isMain: true,
          tracks: [
            {
              id: "t1",
              type: "video",
              name: "Video 1",
              elements: [{ id: "e1", type: "video", startTime: 0, duration: 5 }],
            },
          ],
        },
        {
          id: "scene-2",
          name: "Scene 2",
          isMain: false,
          tracks: [{ id: "t2", type: "audio", name: "Audio 1", elements: [] }],
        },
      ],
      currentSceneId: "scene-1",
    });
    applyTimelineToDoc(doc, base);

    doc.transact(() => {
      doc.getMap("tracks").set("t-live", {
        id: "t-live",
        type: "video",
        name: "Live Video",
      });
      doc.getMap<number>("trackOrderMap").set("t-live", 2);

      const sceneTracksMap = doc.getMap("sceneTracks");
      const scene2Tracks = sceneTracksMap.get("scene-2") as Y.Array<string>;
      scene2Tracks.push(["t-live"]);

      const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
      const liveOrder = new Y.Map<number>();
      liveOrder.set("e1", 0);
      trackElementOrderMaps.set("t-live", liveOrder);
    });

    const agentTimeline = makeTimeline({
      scenes: [
        {
          id: "scene-1",
          name: "Scene 1",
          isMain: true,
          tracks: [{ id: "t1", type: "video", name: "Video 1", elements: [] }],
        },
        {
          id: "scene-2",
          name: "Scene 2",
          isMain: false,
          tracks: [{ id: "t2", type: "audio", name: "Audio 1", elements: [] }],
        },
      ],
      currentSceneId: "scene-2",
    });

    mergeTimelineIntoDoc(doc, agentTimeline, base);

    const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
    expect(doc.getMap("elements").has("e1")).toBe(true);
    expect(orderedIds(trackElementOrderMaps.get("t1") as Y.Map<number>)).not.toContain("e1");
    expect(orderedIds(trackElementOrderMaps.get("t-live") as Y.Map<number>)).toContain("e1");

    const result = docToTimeline(doc);
    const scenes = result.scenes as Record<string, unknown>[];
    const allOccurrences = scenes.flatMap((scene) =>
      (scene.tracks as Record<string, unknown>[]).flatMap((track) =>
        (track.elements as Record<string, unknown>[]).map((element) => ({
          sceneId: scene.id,
          trackId: track.id,
          elementId: element.id,
        })),
      ),
    ).filter((item) => item.elementId === "e1");
    expect(allOccurrences).toEqual([{ sceneId: "scene-2", trackId: "t-live", elementId: "e1" }]);
  });
});
