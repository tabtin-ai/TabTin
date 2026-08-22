/**
 * VSC-016 / VSC-017 / VSC-030 回归测试
 *
 * VSC-016: applyTimelineToDoc 增量更新，复用 element Y.Map，减少 CRDT 操作
 * VSC-017: trackOrder/sceneOrder 先删后追加，避免并发索引偏移
 * VSC-030: mergeTimelineIntoDoc 无 baseTimeline 时跳过无变化字段的 CRDT 写入
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  applyTimelineToDoc,
  mergeTimelineIntoDoc,
  docToTimeline,
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
              { id: "e1", type: "video", startTime: 0, duration: 5, position: { x: 0, y: 0 } },
              { id: "e2", type: "text", startTime: 2, duration: 3, content: "hello" },
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

// ─── VSC-016: 增量更新减少 CRDT 操作 ────────────────────

describe("VSC-016: applyTimelineToDoc 增量更新", () => {
  it("二次 apply 相同数据时复用 element Y.Map（不删除重建）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const elementsMap = doc.getMap("elements");
    const e1Before = elementsMap.get("e1") as Y.Map<unknown>;
    expect(e1Before).toBeInstanceOf(Y.Map);

    applyTimelineToDoc(doc, makeTimeline());

    const e1After = elementsMap.get("e1") as Y.Map<unknown>;
    expect(e1After).toBe(e1Before);
  });

  it("二次 apply 相同数据时 settings 不产生多余 set 调用", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const settingsMap = doc.getMap("settings");
    const setSpy = vi.spyOn(settingsMap, "set");

    applyTimelineToDoc(doc, makeTimeline());

    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("二次 apply 相同数据时 element 字段不产生多余 set 调用", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const elementsMap = doc.getMap("elements");
    const e1 = elementsMap.get("e1") as Y.Map<unknown>;
    const setSpy = vi.spyOn(e1, "set");

    applyTimelineToDoc(doc, makeTimeline());

    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("element 字段变化时只写入变化的字段", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const elementsMap = doc.getMap("elements");
    const e1 = elementsMap.get("e1") as Y.Map<unknown>;
    const setSpy = vi.spyOn(e1, "set");

    const modified = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1",
          elements: [
            { id: "e1", type: "video", startTime: 0, duration: 10, position: { x: 0, y: 0 } },
            { id: "e2", type: "text", startTime: 2, duration: 3, content: "hello" },
          ],
        }, {
          id: "t2", type: "audio", name: "Audio 1",
          elements: [{ id: "e3", type: "audio", startTime: 0, duration: 10 }],
        }],
      }],
    });

    applyTimelineToDoc(doc, modified);

    const setKeys = setSpy.mock.calls.map(c => c[0]);
    expect(setKeys).toContain("duration");
    expect(setKeys).not.toContain("type");
    expect(setKeys).not.toContain("startTime");

    expect(e1.get("duration")).toBe(10);
    setSpy.mockRestore();
  });

  it("不再存在的 element 被增量清理", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const elementsMap = doc.getMap("elements");
    expect(elementsMap.has("e3")).toBe(true);

    const reduced = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1",
          elements: [
            { id: "e1", type: "video", startTime: 0, duration: 5, position: { x: 0, y: 0 } },
          ],
        }],
      }],
    });

    applyTimelineToDoc(doc, reduced);

    expect(elementsMap.has("e1")).toBe(true);
    expect(elementsMap.has("e2")).toBe(false);
    expect(elementsMap.has("e3")).toBe(false);
  });

  it("不再存在的 track 被增量清理", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const tracksMap = doc.getMap("tracks");
    expect(tracksMap.has("t2")).toBe(true);

    const reduced = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{
          id: "t1", type: "video", name: "Video 1",
          elements: [{ id: "e1", type: "video", startTime: 0, duration: 5, position: { x: 0, y: 0 } }],
        }],
      }],
    });

    applyTimelineToDoc(doc, reduced);

    expect(tracksMap.has("t1")).toBe(true);
    expect(tracksMap.has("t2")).toBe(false);
  });

  it("大文档触发 warn 日志", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const doc = new Y.Doc();

    const manyElements = Array.from({ length: 250 }, (_, i) => ({
      id: `e${i}`, type: "video", startTime: i, duration: 1,
    }));
    const bigTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [{ id: "t1", type: "video", name: "V", elements: manyElements }],
      }],
    });

    applyTimelineToDoc(doc, bigTimeline);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("large document"),
    );
    warnSpy.mockRestore();
  });

  it("docToTimeline 往返一致", () => {
    const doc = new Y.Doc();
    const timeline = makeTimeline();
    applyTimelineToDoc(doc, timeline);

    const rebuilt = docToTimeline(doc);
    const scenes = rebuilt.scenes as Record<string, unknown>[];
    expect(scenes.length).toBe(1);
    const tracks = (scenes[0] as Record<string, unknown>).tracks as Record<string, unknown>[];
    expect(tracks.length).toBe(2);
    const els = (tracks[0] as Record<string, unknown>).elements as Record<string, unknown>[];
    expect(els.length).toBe(2);
    expect((els[0] as Record<string, unknown>).id).toBe("e1");

    applyTimelineToDoc(doc, timeline);
    const rebuilt2 = docToTimeline(doc);
    const scenes2 = rebuilt2.scenes as Record<string, unknown>[];
    expect(scenes2.length).toBe(1);
    expect(
      ((scenes2[0] as Record<string, unknown>).tracks as Record<string, unknown>[]).length,
    ).toBe(2);
  });
});

// ─── VSC-017: trackOrderMap/sceneOrderMap（Y.Map）幂等写入 ─

describe("VSC-017: applyTimelineToDoc 使用 Y.Map 幂等写入（替代先删后推）", () => {
  it("N 次 apply 后 trackOrderMap 内容正确，无翻倍", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);
    expect(trackOrderMap.get("t1")).toBe(0);
    expect(trackOrderMap.get("t2")).toBe(1);

    applyTimelineToDoc(doc, makeTimeline());

    expect(trackOrderMap.size).toBe(2);
    expect(trackOrderMap.get("t1")).toBe(0);
    expect(trackOrderMap.get("t2")).toBe(1);
  });

  it("N 次 apply 后 sceneOrderMap 内容正确，无翻倍", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(sceneOrderMap.size).toBe(1);
    expect(sceneOrderMap.get("scene-1")).toBe(0);

    applyTimelineToDoc(doc, makeTimeline());

    expect(sceneOrderMap.size).toBe(1);
    expect(sceneOrderMap.get("scene-1")).toBe(0);
  });

  it("首次 apply 到空 doc 正确写入 Y.Map", () => {
    const doc = new Y.Doc();

    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(trackOrderMap.size).toBe(2);
    expect(sceneOrderMap.size).toBe(1);
  });

  it("替换后 trackOrderMap 内容正确（旧 key 被删除）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.has("t1")).toBe(true);
    expect(trackOrderMap.has("t2")).toBe(true);

    const newTimeline = makeTimeline({
      scenes: [{
        id: "scene-1", name: "Main", isMain: true,
        tracks: [
          { id: "t3", type: "video", name: "V3", elements: [] },
          { id: "t4", type: "audio", name: "A4", elements: [] },
        ],
      }],
    });

    applyTimelineToDoc(doc, newTimeline);

    expect(trackOrderMap.has("t1")).toBe(false);
    expect(trackOrderMap.has("t2")).toBe(false);
    expect(trackOrderMap.has("t3")).toBe(true);
    expect(trackOrderMap.has("t4")).toBe(true);
    expect(trackOrderMap.get("t3")).toBe(0);
    expect(trackOrderMap.get("t4")).toBe(1);
  });
});

// ─── VSC-030: 无 baseTimeline 时跳过无效 CRDT 写入 ──────

describe("VSC-030: mergeTimelineIntoDoc 无 baseTimeline 跳过无变化写入", () => {
  it("无 baseTimeline + 无变化时 settingsMap 不产生 set 调用", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const settingsMap = doc.getMap("settings");
    const setSpy = vi.spyOn(settingsMap, "set");

    mergeTimelineIntoDoc(doc, makeTimeline(), undefined);

    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("无 baseTimeline + 无变化时 meta 不产生 set 调用", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const meta = doc.getMap("meta");
    const setSpy = vi.spyOn(meta, "set");

    mergeTimelineIntoDoc(doc, makeTimeline(), undefined);

    const setKeys = setSpy.mock.calls.map(c => c[0]);
    expect(setKeys).not.toContain("projectId");
    expect(setKeys).not.toContain("name");
    expect(setKeys).not.toContain("duration");
    setSpy.mockRestore();
  });

  it("无 baseTimeline + 有变化时正确写入变化字段", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const settingsMap = doc.getMap("settings");
    settingsMap.set("fps", 60);

    mergeTimelineIntoDoc(doc, makeTimeline(), undefined);

    expect(settingsMap.get("fps")).toBe(30);
  });

  it("无 baseTimeline 时 track meta 相同则不写入", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeTimeline());

    const tracksMap = doc.getMap("tracks");
    const setSpy = vi.spyOn(tracksMap, "set");

    mergeTimelineIntoDoc(doc, makeTimeline(), undefined);

    const trackSetCalls = setSpy.mock.calls.filter(c => c[0] === "t1" || c[0] === "t2");
    expect(trackSetCalls.length).toBe(0);
    setSpy.mockRestore();
  });

  it("有 baseTimeline 时保留原有三方合并语义", () => {
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
});
