/**
 * CR-025 回归测试：Y.Map 幂等写入防止翻倍
 *
 * W5-Purge：CR-024（Canvas mergeGraphIntoDoc pageOrder Y.Map）已删，
 * Canvas pageOrder 改用 page record + index 字段，没有顶层 Y.Array / Y.Map。
 *
 * CR-025: Video applyTimelineToDoc Y.Map 幂等写入（VSC-017 修复后）
 */
import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  applyTimelineToDoc,
  docToTimeline,
} from "../extensions/video-database.js";

// ─── helpers ────────────────────────────────────────────

function makeVideoTimeline(overrides?: Record<string, unknown>) {
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

// ─── CR-025: Video applyTimelineToDoc Y.Map 幂等写入（迁移后更新） ──

describe("CR-025: applyTimelineToDoc Y.Map 幂等写入（VSC-017 → trackOrderMap/sceneOrderMap）", () => {
  it("第二次 apply 后 trackOrderMap 和 sceneOrderMap 正确", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeVideoTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(trackOrderMap.size).toBe(2);
    expect(sceneOrderMap.size).toBe(1);

    applyTimelineToDoc(doc, makeVideoTimeline({
      scenes: [{
        id: "scene-2",
        name: "New Scene",
        isMain: true,
        tracks: [
          { id: "t3", type: "video", name: "V3", elements: [] },
        ],
      }],
      currentSceneId: "scene-2",
    }));

    expect(trackOrderMap.size).toBe(1);
    expect(trackOrderMap.has("t3")).toBe(true);
    expect(trackOrderMap.get("t3")).toBe(0);
    expect(sceneOrderMap.size).toBe(1);
    expect(sceneOrderMap.has("scene-2")).toBe(true);
  });

  it("trackOrderMap 替换 Y.Array：N 次 apply 后内容幂等（无翻倍）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeVideoTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    expect(trackOrderMap.size).toBe(2);

    applyTimelineToDoc(doc, makeVideoTimeline());

    // Y.Map 天然幂等——相同 key 覆盖，不翻倍
    expect(trackOrderMap.size).toBe(2);
    expect(trackOrderMap.get("t1")).toBe(0);
    expect(trackOrderMap.get("t2")).toBe(1);
  });

  it("sceneOrderMap 替换 Y.Array：N 次 apply 后内容幂等（无翻倍）", () => {
    const doc = new Y.Doc();
    applyTimelineToDoc(doc, makeVideoTimeline());

    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(sceneOrderMap.size).toBe(1);

    applyTimelineToDoc(doc, makeVideoTimeline());

    expect(sceneOrderMap.size).toBe(1);
    expect(sceneOrderMap.get("scene-1")).toBe(0);
  });

  it("首次 apply 到空 doc 正确写入 Y.Map（无需 delete）", () => {
    const doc = new Y.Doc();

    applyTimelineToDoc(doc, makeVideoTimeline());

    const trackOrderMap = doc.getMap<number>("trackOrderMap");
    const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
    expect(trackOrderMap.size).toBe(2);
    expect(sceneOrderMap.size).toBe(1);
  });

  it("多场景 apply 后重建正确（docToTimeline 往返一致）", () => {
    const doc = new Y.Doc();
    const multiSceneTimeline = makeVideoTimeline({
      scenes: [
        {
          id: "s1", name: "Intro", isMain: true,
          tracks: [{ id: "t1", type: "video", name: "V", elements: [{ id: "e1", type: "video", startTime: 0, duration: 3 }] }],
        },
        {
          id: "s2", name: "Body", isMain: false,
          tracks: [{ id: "t2", type: "audio", name: "A", elements: [] }],
        },
      ],
    });
    applyTimelineToDoc(doc, multiSceneTimeline);

    const rebuilt = docToTimeline(doc);
    const scenes = rebuilt.scenes as Record<string, unknown>[];
    expect(scenes.length).toBe(2);
    expect((scenes[0] as Record<string, unknown>).id).toBe("s1");
    expect((scenes[1] as Record<string, unknown>).id).toBe("s2");

    applyTimelineToDoc(doc, multiSceneTimeline);
    const rebuilt2 = docToTimeline(doc);
    const scenes2 = rebuilt2.scenes as Record<string, unknown>[];
    expect(scenes2.length).toBe(2);
    expect((scenes2[0] as Record<string, unknown>).id).toBe("s1");
    expect((scenes2[1] as Record<string, unknown>).id).toBe("s2");
  });
});
