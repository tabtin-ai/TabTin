/**
 * Video Database Extension
 *
 * TabVideo 的 Hocuspocus 持久化扩展，继承 BaseCollabDatabase。
 *
 * Y.Doc 数据模型（element 级 CRDT，支持 Agent 和用户并行编辑）：
 *   tracks:         Y.Map<trackId, trackMetaJSON>           — 轨道元数据
 *   elements:       Y.Map<elementId, Y.Map>                 — 所有元素的扁平映射
 *   trackOrderMap:  Y.Map<trackId, number>                  — 轨道排序（ID→position）
 *   sceneOrderMap:  Y.Map<sceneId, number>                  — 场景排序（ID→position）
 *   trackElementOrderMaps: Y.Map<trackId, Y.Map<elementId, number>> — 每轨道元素排序
 *   settings:       Y.Map  — { fps, width, height, bgType, bgColor }
 *   meta:           Y.Map  — { projectId, name, duration, version, currentSceneId, createdAt }
 *   scenes:         Y.Map<sceneId, sceneMetaJSON>           — 场景元数据（多场景模式）
 *   sceneTracks:    Y.Map<sceneId, Y.Array<trackId>>        — 每个场景的轨道列表
 *
 *   [DEPRECATED — 仅用于 fallback 读取旧文档]:
 *   trackOrder:     Y.Array<trackId>                        — 轨道顺序
 *   trackElements:  Y.Map<trackId, Y.Array<elementId>>      — 每个轨道的元素顺序
 *   sceneOrder:     Y.Array<sceneId>                        — 场景顺序
 */

import * as Y from "yjs";
import { BaseCollabDatabase, type PersistPayload } from "./base-collab-database.js";
import { yMapToPlain, getOrderedIds, setOrderedIds } from "../lib/y-utils.js";
import { extractEditorInfo } from "../lib/collab-utils.js";
import { deepEqual } from "../lib/deep-equal.js";

const SKIP_ELEMENT_KEYS = new Set(["buffer"]);

/** 安全提取数组，非数组值返回空数组 */
function safeArray<T>(val: unknown): T[] {
  return Array.isArray(val) ? (val as T[]) : [];
}

function normalizeElementForCompare(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SKIP_ELEMENT_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result;
}

function yElementMatchesBase(
  elementsMap: Y.Map<unknown>,
  elementId: string,
  baseElement?: Record<string, unknown>,
): boolean {
  if (!baseElement) return false;
  const current = elementsMap.get(elementId);
  if (!(current instanceof Y.Map)) return false;
  return deepEqual(yMapToPlain(current), normalizeElementForCompare(baseElement));
}

interface ElementMembership {
  trackId: string;
  sceneId?: string;
}

function sameElementMembership(
  left: ElementMembership | undefined,
  right: ElementMembership | undefined,
): boolean {
  if (!left || !right) return false;
  if (left.trackId !== right.trackId) return false;
  return left.sceneId === undefined || right.sceneId === undefined || left.sceneId === right.sceneId;
}

function readTrackSceneMembership(sceneTracksMap: Y.Map<unknown>): Map<string, string> {
  const membership = new Map<string, string>();
  sceneTracksMap.forEach((value: unknown, sceneId: string) => {
    if (!(value instanceof Y.Array)) return;
    for (let i = 0; i < value.length; i++) {
      const trackId = String(value.get(i) || "");
      if (trackId && !membership.has(trackId)) membership.set(trackId, sceneId);
    }
  });
  return membership;
}

function readElementMembership(
  trackElementOrderMaps: Y.Map<unknown>,
  trackSceneMembership: Map<string, string>,
): Map<string, ElementMembership> {
  const membership = new Map<string, ElementMembership>();
  trackElementOrderMaps.forEach((value: unknown, trackId: string) => {
    if (!(value instanceof Y.Map)) return;
    for (const elementId of getOrderedIds(value as Y.Map<number>)) {
      if (!elementId || membership.has(elementId)) continue;
      membership.set(elementId, {
        trackId,
        sceneId: trackSceneMembership.get(trackId),
      });
    }
  });
  return membership;
}

function trackMetaChangedFromBase(
  trackMeta: Record<string, unknown>,
  baseTrack?: Record<string, unknown>,
): boolean {
  if (!baseTrack) return true;
  const baseMeta = { ...baseTrack };
  delete baseMeta.elements;
  return !deepEqual(trackMeta, baseMeta);
}

function readTrackElementIds(
  trackElementOrderMaps: Y.Map<unknown>,
  trackId: string,
): string[] {
  const elOrderMap = trackElementOrderMaps.get(trackId) as Y.Map<number> | undefined;
  return elOrderMap instanceof Y.Map ? getOrderedIds(elOrderMap) : [];
}

function readSceneTrackIds(
  sceneTracksMap: Y.Map<unknown>,
  sceneId: string,
): string[] {
  const sceneTrackIds = sceneTracksMap.get(sceneId) as Y.Array<string> | undefined;
  return sceneTrackIds instanceof Y.Array ? sceneTrackIds.toArray() : [];
}

function elementOnlyBelongsToTrack(
  trackElementOrderMaps: Y.Map<unknown>,
  elementId: string,
  expectedTrackId: string,
): boolean {
  let ownerCount = 0;
  let belongsToExpectedTrack = false;
  trackElementOrderMaps.forEach((value: unknown, trackId: string) => {
    if (!(value instanceof Y.Map)) return;
    if (!value.has(elementId)) return;
    ownerCount += 1;
    if (trackId === expectedTrackId) belongsToExpectedTrack = true;
  });
  return belongsToExpectedTrack && ownerCount === 1;
}

function elementHasOtherTrackMembership(
  trackElementOrderMaps: Y.Map<unknown>,
  elementId: string,
  currentTrackId: string,
): boolean {
  let hasOtherMembership = false;
  trackElementOrderMaps.forEach((value: unknown, trackId: string) => {
    if (hasOtherMembership || trackId === currentTrackId || !(value instanceof Y.Map)) return;
    if (value.has(elementId)) hasOtherMembership = true;
  });
  return hasOtherMembership;
}

function liveTrackMatchesBaseForDeletion(
  tracksMap: Y.Map<unknown>,
  elementsMap: Y.Map<unknown>,
  trackElementOrderMaps: Y.Map<unknown>,
  currentTrackSceneMembership: Map<string, string>,
  trackId: string,
  baseTrack: Record<string, unknown> | undefined,
  baseSceneId: string | undefined,
  baseElementOrder: string[],
  baseElementsById: Map<string, Record<string, unknown>>,
): boolean {
  if (!baseTrack) return false;

  const currentTrack = tracksMap.get(trackId);
  if (!currentTrack) return true;

  if (baseSceneId && currentTrackSceneMembership.get(trackId) !== baseSceneId) {
    return false;
  }

  const currentTrackMeta = currentTrack instanceof Y.Map
    ? yMapToPlain(currentTrack)
    : currentTrack as Record<string, unknown>;
  if (trackMetaChangedFromBase(currentTrackMeta, baseTrack)) {
    return false;
  }

  const currentElementOrder = readTrackElementIds(trackElementOrderMaps, trackId);
  if (
    currentElementOrder.length !== baseElementOrder.length ||
    currentElementOrder.some((elementId, index) => elementId !== baseElementOrder[index])
  ) {
    return false;
  }

  for (const elementId of baseElementOrder) {
    if (!yElementMatchesBase(elementsMap, elementId, baseElementsById.get(elementId))) {
      return false;
    }
    if (!elementOnlyBelongsToTrack(trackElementOrderMaps, elementId, trackId)) {
      return false;
    }
  }

  return true;
}

function liveSceneMatchesBaseForDeletion(
  scenesMap: Y.Map<unknown>,
  sceneTracksMap: Y.Map<unknown>,
  tracksMap: Y.Map<unknown>,
  elementsMap: Y.Map<unknown>,
  trackElementOrderMaps: Y.Map<unknown>,
  currentTrackSceneMembership: Map<string, string>,
  sceneId: string,
  baseScene: Record<string, unknown> | undefined,
  baseTrackMap: Map<string, Record<string, unknown>>,
  baseTrackSceneMembership: Map<string, string>,
  baseElementOrderByTrack: Map<string, string[]>,
  baseElementsById: Map<string, Record<string, unknown>>,
): boolean {
  if (!baseScene) return false;

  const currentScene = scenesMap.get(sceneId);
  if (!currentScene) return true;

  const currentSceneMeta = currentScene instanceof Y.Map
    ? yMapToPlain(currentScene)
    : currentScene as Record<string, unknown>;
  if (sceneMetaChangedFromBase(currentSceneMeta, baseScene)) {
    return false;
  }

  const currentSceneTrackIds = readSceneTrackIds(sceneTracksMap, sceneId);
  const baseSceneTrackIds = safeArray<Record<string, unknown>>(baseScene.tracks)
    .map((track) => track.id as string | undefined)
    .filter((trackId): trackId is string => Boolean(trackId));
  if (
    currentSceneTrackIds.length !== baseSceneTrackIds.length ||
    currentSceneTrackIds.some((trackId, index) => trackId !== baseSceneTrackIds[index])
  ) {
    return false;
  }

  for (const trackId of baseSceneTrackIds) {
    const canDeleteTrack = liveTrackMatchesBaseForDeletion(
      tracksMap,
      elementsMap,
      trackElementOrderMaps,
      currentTrackSceneMembership,
      trackId,
      baseTrackMap.get(trackId),
      baseTrackSceneMembership.get(trackId),
      baseElementOrderByTrack.get(trackId) ?? [],
      baseElementsById,
    );
    if (!canDeleteTrack) return false;
  }

  return true;
}

function sceneMetaChangedFromBase(
  sceneMeta: Record<string, unknown>,
  baseScene?: Record<string, unknown>,
): boolean {
  if (!baseScene) return true;
  const baseMeta = { ...baseScene };
  delete baseMeta.tracks;
  return !deepEqual(sceneMeta, baseMeta);
}

function setSceneNameFromScene(
  meta: Y.Map<unknown>,
  scene: Record<string, unknown>,
  baseScene?: Record<string, unknown>,
): void {
  const nextSceneName = (scene.name as string) ?? "主场景";
  if (baseScene) {
    const baseSceneName = (baseScene.name as string) ?? "主场景";
    if (deepEqual(baseSceneName, nextSceneName)) return;
  }
  setIfChanged(meta, "sceneName", nextSceneName);
}

function createSceneMeta(
  scene: Record<string, unknown>,
  sceneId: string,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: sceneId,
    name: scene.name ?? "场景",
    isMain: scene.isMain ?? false,
    bookmarks: scene.bookmarks ?? [],
    createdAt: scene.createdAt ?? now,
    updatedAt: scene.updatedAt ?? now,
  };
}

function mergeSceneMetaFromBase(
  existing: Record<string, unknown>,
  scene: Record<string, unknown>,
  baseScene: Record<string, unknown>,
  sceneId: string,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing, id: sceneId };
  for (const [key, value] of Object.entries(scene)) {
    if (key === "tracks" || key === "id") continue;
    if (!deepEqual(baseScene[key], value)) {
      merged[key] = value;
    }
  }
  return merged;
}

type ForceResyncMediaRefs =
  | boolean
  | {
    mediaIds?: string[];
    media_ids?: string[];
  };

interface MergeTimelineOptions {
  forceResyncMediaRefs?: ForceResyncMediaRefs;
}

function normalizeForceResyncMediaIds(
  forceResyncMediaRefs: ForceResyncMediaRefs | undefined,
): Set<string> | null | undefined {
  if (!forceResyncMediaRefs) return undefined;
  if (forceResyncMediaRefs === true) return null;
  const rawIds = [
    ...safeArray<string>(forceResyncMediaRefs.mediaIds),
    ...safeArray<string>(forceResyncMediaRefs.media_ids),
  ];
  return new Set(rawIds.map((id) => String(id)).filter(Boolean));
}

function shouldForceResyncMediaRefsForElement(
  element: Record<string, unknown>,
  forcedMediaIds: Set<string> | null | undefined,
): boolean {
  if (forcedMediaIds === undefined) return false;
  const type = String(element.type || "");
  if (type !== "video" && type !== "image") return false;
  const mediaId = String(element.mediaId || "");
  if (!mediaId) return false;
  if (forcedMediaIds && !forcedMediaIds.has(mediaId)) return false;
  return "fileUrl" in element || "mediaPropsHash" in element;
}

function collectForcedMediaRefValues(
  scenes: Record<string, unknown>[],
  forcedMediaIds: Set<string> | null | undefined,
): Map<string, { fileUrl?: string; mediaPropsHash?: string }> {
  const refs = new Map<string, { fileUrl?: string; mediaPropsHash?: string }>();
  if (forcedMediaIds === undefined) return refs;
  for (const scene of scenes) {
    for (const track of safeArray<Record<string, unknown>>(scene.tracks)) {
      for (const element of safeArray<Record<string, unknown>>(track.elements)) {
        if (!shouldForceResyncMediaRefsForElement(element, forcedMediaIds)) continue;
        const mediaId = String(element.mediaId || "");
        if (!mediaId) continue;
        refs.set(mediaId, {
          fileUrl: typeof element.fileUrl === "string" ? element.fileUrl : undefined,
          mediaPropsHash: typeof element.mediaPropsHash === "string" ? element.mediaPropsHash : undefined,
        });
      }
    }
  }
  return refs;
}

function applyForcedMediaRefsToExistingElements(
  elementsMap: Y.Map<unknown>,
  refs: Map<string, { fileUrl?: string; mediaPropsHash?: string }>,
): void {
  if (refs.size === 0) return;
  elementsMap.forEach((value: unknown) => {
    if (!(value instanceof Y.Map)) return;
    const type = String(value.get("type") || "");
    if (type !== "video" && type !== "image") return;
    const currentMediaId = String(value.get("mediaId") || "");
    if (!currentMediaId) return;
    const ref = refs.get(currentMediaId);
    if (!ref) return;
    if (ref.fileUrl !== undefined && !deepEqual(value.get("fileUrl"), ref.fileUrl)) {
      value.set("fileUrl", ref.fileUrl);
    }
    if (ref.mediaPropsHash !== undefined && !deepEqual(value.get("mediaPropsHash"), ref.mediaPropsHash)) {
      value.set("mediaPropsHash", ref.mediaPropsHash);
    }
  });
}

/** 只在值真正变化时写入 Y.Map，避免无效 CRDT 操作 */
function setIfChanged(ymap: Y.Map<unknown>, key: string, value: unknown): void {
  if (!deepEqual(ymap.get(key), value)) {
    ymap.set(key, value);
  }
}

/**
 * 全量应用 plain data 到已有 Y.Map，复用嵌套 Y.Map 结构。
 * 只写入真正变化的字段，删除新数据中不存在的旧字段。
 */
function applyFieldsToYMap(
  ymap: Y.Map<unknown>,
  data: Record<string, unknown>,
): void {
  const newKeys = new Set<string>();
  for (const [key, value] of Object.entries(data)) {
    if (SKIP_ELEMENT_KEYS.has(key)) continue;
    newKeys.add(key);
    const existing = ymap.get(key);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      if (existing instanceof Y.Map) {
        applyFieldsToYMap(existing, value as Record<string, unknown>);
      } else {
        const nested = new Y.Map<unknown>();
        for (const [nk, nv] of Object.entries(value as Record<string, unknown>)) {
          nested.set(nk, nv);
        }
        ymap.set(key, nested);
      }
    } else {
      if (!deepEqual(existing, value)) {
        ymap.set(key, value);
      }
    }
  }
  const keysToDelete: string[] = [];
  ymap.forEach((_: unknown, key: string) => {
    if (!newKeys.has(key)) keysToDelete.push(key);
  });
  for (const key of keysToDelete) ymap.delete(key);
}

/** 增量清理 Y.Map：删除不在 validKeys 中的条目 */
function cleanupMap(map: Y.Map<unknown>, validKeys: Set<string>): void {
  const toDelete: string[] = [];
  map.forEach((_: unknown, k: string) => { if (!validKeys.has(k)) toDelete.push(k); });
  for (const k of toDelete) map.delete(k);
}

/**
 * VID-L4: timeline 双哈希 digest（FNV-1a + djb2，64-bit 碰撞抗性）。
 * 直接遍历 Y.Doc map 结构计算哈希，避免 docToTimeline + JSON.stringify 的 O(N) 中间对象分配。
 * 100+ 轨道 × 多元素场景下，无变更跳过路径从 ~50ms 降至 ~2ms。
 * 排除 meta.version（服务端计数器，非用户内容），保证 onStoreSuccess 版本更新后 digest 仍稳定。
 */
function computeTimelineDigest(ydoc: Y.Doc): string {
  let h1 = 2166136261;
  let h2 = 5381;

  const feed = (c: number) => {
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = ((h2 << 5) + h2 + c) | 0;
  };

  const feedStr = (str: string) => {
    for (let i = 0; i < str.length; i++) feed(str.charCodeAt(i));
    feed(0x1f);
  };

  const feedValue = (val: unknown): void => {
    if (val instanceof Y.Map) {
      feedStr("\x00M");
      const keys: string[] = [];
      val.forEach((_: unknown, k: string) => {
        if (!SKIP_ELEMENT_KEYS.has(k)) keys.push(k);
      });
      keys.sort();
      for (const k of keys) { feedStr(k); feedValue(val.get(k)); }
      feedStr("\x00}");
    } else if (val instanceof Y.Array) {
      feedStr("\x00A");
      for (let i = 0; i < val.length; i++) feedValue(val.get(i));
      feedStr("\x00]");
    } else if (Array.isArray(val)) {
      feedStr("\x00[");
      for (const item of val) feedValue(item);
      feedStr("\x00]");
    } else if (val !== null && typeof val === "object") {
      feedStr("\x00O");
      const obj = val as Record<string, unknown>;
      const keys = Object.keys(obj).sort();
      for (const k of keys) { feedStr(k); feedValue(obj[k]); }
      feedStr("\x00}");
    } else {
      feedStr(
        val === null ? "\x01null" :
        val === undefined ? "\x01undef" :
        typeof val === "string" ? `\x02${val}` :
        typeof val === "number" ? `\x03${val}` :
        typeof val === "boolean" ? (val ? "\x04T" : "\x04F") :
        `\x05${val}`,
      );
    }
  };

  const settingsMap = ydoc.getMap("settings");
  feedStr("S");
  const sKeys: string[] = [];
  settingsMap.forEach((_: unknown, k: string) => sKeys.push(k));
  sKeys.sort();
  for (const k of sKeys) { feedStr(k); feedValue(settingsMap.get(k)); }

  const meta = ydoc.getMap("meta");
  feedStr("M");
  const mKeys: string[] = [];
  meta.forEach((_: unknown, k: string) => { if (k !== "version") mKeys.push(k); });
  mKeys.sort();
  for (const k of mKeys) { feedStr(k); feedValue(meta.get(k)); }

  const trackOrderMap = ydoc.getMap<number>("trackOrderMap");
  const trackIds = getOrderedIds(trackOrderMap);
  const tracksMap = ydoc.getMap("tracks");
  feedStr(`T${trackIds.length}`);
  for (const tid of trackIds) {
    feedStr(tid);
    feedValue(tracksMap.get(tid));
  }

  const elementsMap = ydoc.getMap("elements");
  const trackElementOrderMaps = ydoc.getMap("trackElementOrderMaps");
  feedStr("E");
  for (const tid of trackIds) {
    const elOrderMap = trackElementOrderMaps.get(tid) as Y.Map<number> | undefined;
    if (!(elOrderMap instanceof Y.Map)) continue;
    const elIds = getOrderedIds(elOrderMap);
    feedStr(`${tid}:${elIds.length}`);
    for (const eid of elIds) {
      feedStr(eid);
      feedValue(elementsMap.get(eid));
    }
  }

  const sceneOrderMap = ydoc.getMap<number>("sceneOrderMap");
  const sceneIds = getOrderedIds(sceneOrderMap);
  const scenesMap = ydoc.getMap("scenes");
  feedStr(`SC${sceneIds.length}`);
  for (const sid of sceneIds) {
    feedStr(sid);
    feedValue(scenesMap.get(sid));
  }

  const sceneTracksMap = ydoc.getMap("sceneTracks");
  feedStr("ST");
  for (const sid of sceneIds) {
    const arr = sceneTracksMap.get(sid);
    if (arr instanceof Y.Array) {
      feedStr(`${sid}:`);
      for (let i = 0; i < arr.length; i++) feedStr(String(arr.get(i)));
    }
  }

  return `${h1 >>> 0}:${h2 >>> 0}`;
}

/**
 * 获取或创建每轨道的 elementOrderMap（Y.Map<elementId, number>）。
 * trackElementOrderMaps 是 Y.Map<trackId, Y.Map<elementId, number>>。
 */
function getOrCreateElementOrderMap(
  trackElementOrderMaps: Y.Map<unknown>,
  trackId: string,
): Y.Map<number> {
  let elOrderMap = trackElementOrderMaps.get(trackId) as Y.Map<number> | undefined;
  if (!(elOrderMap instanceof Y.Map)) {
    elOrderMap = new Y.Map<number>();
    trackElementOrderMaps.set(trackId, elOrderMap);
  }
  return elOrderMap;
}

/**
 * 将 TProject JSON 写入 Y.Doc
 *
 * VSC-016: 增量式更新——复用已有 element Y.Map 做字段级 diff，
 *          增量清理而非全量清空，减少 CRDT 操作和墓碑。
 * VSC-017: 使用 Y.Map（setOrderedIds）替代 Y.Array delete+push，避免并发索引偏移。
 *
 * step1+step2+step3+step4: 完整 Y.Array→Y.Map 迁移
 *   - trackOrderMap / sceneOrderMap / trackElementOrderMaps 为主数据源（Y.Map）
 *   - trackOrder / sceneOrder / trackElements（Y.Array）已移除
 */
function applyTimelineToDoc(
  doc: Y.Doc,
  timelineData: Record<string, unknown> | null,
): void {
  if (!timelineData || !doc) return;

  const tracksMap = doc.getMap("tracks");
  const elementsMap = doc.getMap("elements");
  const trackOrderMap = doc.getMap<number>("trackOrderMap");
  const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
  const settingsMap = doc.getMap("settings");
  const meta = doc.getMap("meta");
  const scenesMap = doc.getMap("scenes");
  const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
  const sceneTracksMap = doc.getMap("sceneTracks");

  const scenes = safeArray<Record<string, unknown>>(timelineData.scenes);

  let totalElements = 0;
  for (const scene of scenes) {
    for (const track of safeArray<Record<string, unknown>>(scene.tracks)) {
      totalElements += safeArray(track.elements).length;
    }
  }
  if (totalElements > 200) {
    console.warn(
      `[VideoDB] applyTimelineToDoc: large document (${totalElements} elements) — ` +
      `consider using mergeTimelineIntoDoc for incremental updates`,
    );
  }

  doc.transact(() => {
    const s = (timelineData.settings as Record<string, unknown>) ?? {};
    const cs = (s.canvasSize as Record<string, number>) ?? {};
    const bg = (s.background as Record<string, unknown>) ?? {};
    setIfChanged(settingsMap, "fps", s.fps ?? 30);
    setIfChanged(settingsMap, "width", cs.width ?? 1920);
    setIfChanged(settingsMap, "height", cs.height ?? 1080);
    setIfChanged(settingsMap, "bgType", bg.type ?? "color");
    setIfChanged(settingsMap, "bgColor", bg.color ?? "#000000");

    const md = (timelineData.metadata as Record<string, unknown>) ?? {};
    setIfChanged(meta, "projectId", md.id ?? "");
    setIfChanged(meta, "name", md.name ?? "");
    setIfChanged(meta, "duration", md.duration ?? 0);
    setIfChanged(meta, "version", (timelineData.version as number) ?? 1);
    setIfChanged(meta, "currentSceneId", timelineData.currentSceneId ?? "");
    setIfChanged(meta, "createdAt", md.createdAt || new Date().toISOString());
    // VID-008: 将 updatedAt 存入 meta，docToTimeline 读取时使用稳定值
    setIfChanged(meta, "updatedAt", md.updatedAt || new Date().toISOString());
    // VID-005: 始终写入 sceneName 作为单场景路径回退
    if (scenes.length > 0) {
      const firstScene = scenes[0] as Record<string, unknown>;
      setIfChanged(meta, "sceneName", firstScene.name ?? "主场景");
    }

    const newTrackIds = new Set<string>();
    const newElementIds = new Set<string>();
    const newSceneIds = new Set<string>();

    // 收集所有新的轨道和场景 ID，用于全量 setOrderedIds
    const allSceneIds: string[] = [];
    const allTrackIds: string[] = [];

    for (const scene of scenes) {
      const sceneId = (scene.id as string) ?? "";
      if (!sceneId) continue;
      allSceneIds.push(sceneId);
    }

    for (const scene of scenes) {
      const sceneId = (scene.id as string) ?? "";
      if (!sceneId) continue;

      newSceneIds.add(sceneId);
      scenesMap.set(sceneId, {
        id: sceneId,
        name: scene.name ?? "场景",
        isMain: scene.isMain ?? false,
        bookmarks: scene.bookmarks ?? [],
        createdAt: scene.createdAt ?? new Date().toISOString(),
        updatedAt: scene.updatedAt ?? new Date().toISOString(),
      });

      const sceneTracks = safeArray<Record<string, unknown>>(scene.tracks);

      // VID-002: 复用已有 Y.Array 避免孤立墓碑和 CRDT merge 叠加
      let sceneTrackIds = sceneTracksMap.get(sceneId) as Y.Array<string> | undefined;
      if (sceneTrackIds) {
        if (sceneTrackIds.length > 0) sceneTrackIds.delete(0, sceneTrackIds.length);
      } else {
        sceneTrackIds = new Y.Array<string>();
      }

      for (const track of sceneTracks) {
        const trackId = track.id as string;
        if (!trackId) continue;

        newTrackIds.add(trackId);
        allTrackIds.push(trackId);
        const { elements: _els, ...trackMeta } = track;
        tracksMap.set(trackId, trackMeta);
        sceneTrackIds.push([trackId]);

        const elArray = safeArray<Record<string, unknown>>(_els);
        const elIds: string[] = [];

        // step1+step2: 同时维护 trackElementOrderMaps（Y.Map）
        const elOrderMap = getOrCreateElementOrderMap(trackElementOrderMaps, trackId);

        for (const el of elArray) {
          const elId = el.id as string;
          if (!elId) continue;

          newElementIds.add(elId);
          elIds.push(elId);

          // VSC-016: 复用已有 element Y.Map，字段级 diff 更新
          const existingYMap = elementsMap.get(elId);
          if (existingYMap instanceof Y.Map) {
            applyFieldsToYMap(existingYMap, el);
          } else {
            const elYMap = new Y.Map<unknown>();
            for (const [key, value] of Object.entries(el)) {
              if (SKIP_ELEMENT_KEYS.has(key)) continue;
              if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                const nested = new Y.Map<unknown>();
                for (const [nk, nv] of Object.entries(value as Record<string, unknown>)) {
                  nested.set(nk, nv);
                }
                elYMap.set(key, nested);
              } else {
                elYMap.set(key, value);
              }
            }
            elementsMap.set(elId, elYMap);
          }
        }

        // step3+step4: Y.Map 为主数据源，全量写入 element 排序
        setOrderedIds(elOrderMap, elIds);
      }

      // VID-002: 仅新建时 set，复用时已在 map 中
      if (!sceneTracksMap.has(sceneId)) {
        sceneTracksMap.set(sceneId, sceneTrackIds);
      }
    }

    // step3+step4: Y.Map 为主数据源，全量写入 track/scene 排序
    setOrderedIds(trackOrderMap, allTrackIds);
    setOrderedIds(sceneOrderMap, allSceneIds);

    // VSC-016: 增量清理——只删除不在新数据中的条目
    cleanupMap(tracksMap, newTrackIds);
    cleanupMap(elementsMap, newElementIds);
    cleanupMap(trackElementOrderMaps, newTrackIds);
    cleanupMap(scenesMap, newSceneIds);
    cleanupMap(sceneTracksMap, newSceneIds);
  });
}

/**
 * 增量合并 timeline 到 Y.Doc（Agent push 专用）
 *
 * 与 applyTimelineToDoc 的区别：
 *   - 不清空现有数据（保留用户的并发编辑）
 *   - 只添加新 element/track，更新已有 element 的变化属性
 *   - 支持三方合并（base → new vs current）
 *
 * step2+step3+step4: 同时维护 Y.Map 排序字段
 */
function mergeTimelineIntoDoc(
  doc: Y.Doc,
  timelineData: Record<string, unknown> | null,
  baseTimeline?: Record<string, unknown> | null,
  options: MergeTimelineOptions = {},
): void {
  if (!timelineData || !doc) return;

  const tracksMap = doc.getMap("tracks");
  const elementsMap = doc.getMap("elements");
  const trackOrderMap = doc.getMap<number>("trackOrderMap");
  const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
  const settingsMap = doc.getMap("settings");
  const meta = doc.getMap("meta");
  const scenesMap = doc.getMap("scenes");
  const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
  const sceneTracksMap = doc.getMap("sceneTracks");
  const forcedMediaIds = normalizeForceResyncMediaIds(options.forceResyncMediaRefs);

  doc.transact(() => {
    // Settings: 字段级合并，只更新相对 base 有变化的字段，保留用户并发编辑
    const s = (timelineData.settings as Record<string, unknown>) ?? {};
    const cs = (s.canvasSize as Record<string, number>) ?? {};
    const bg = (s.background as Record<string, unknown>) ?? {};
    const baseSettings = (baseTimeline?.settings as Record<string, unknown>) ?? {};
    const baseCs = (baseSettings.canvasSize as Record<string, number>) ?? {};
    const baseBg = (baseSettings.background as Record<string, unknown>) ?? {};

    const settingsFields: Array<[string, unknown, unknown]> = [
      ["fps", s.fps ?? 30, baseSettings.fps],
      ["width", cs.width ?? 1920, baseCs.width],
      ["height", cs.height ?? 1080, baseCs.height],
      ["bgType", bg.type ?? "color", baseBg.type],
      ["bgColor", bg.color ?? "#000000", baseBg.color],
    ];
    for (const [key, newVal, baseVal] of settingsFields) {
      if (baseTimeline ? !deepEqual(baseVal, newVal) : !deepEqual(settingsMap.get(key), newVal)) {
        settingsMap.set(key, newVal);
      }
    }

    // Meta: 字段级合并
    const md = (timelineData.metadata as Record<string, unknown>) ?? {};
    const baseMd = (baseTimeline?.metadata as Record<string, unknown>) ?? {};
    const metaFields: Array<[string, unknown, unknown]> = [
      ["projectId", md.id ?? "", baseMd.id],
      ["name", md.name ?? "", baseMd.name],
      ["duration", md.duration ?? 0, baseMd.duration],
      ["version", (timelineData.version as number) ?? 1, baseTimeline?.version],
      ["currentSceneId", timelineData.currentSceneId ?? "", baseTimeline?.currentSceneId],
      ["createdAt", md.createdAt || new Date().toISOString(), baseMd.createdAt],
      // VID-008: 将 updatedAt 存入 meta
      ["updatedAt", md.updatedAt || new Date().toISOString(), baseMd.updatedAt],
    ];
    for (const [key, newVal, baseVal] of metaFields) {
      if (baseTimeline ? !deepEqual(baseVal, newVal) : !deepEqual(meta.get(key), newVal)) {
        meta.set(key, newVal);
      }
    }

    // VID-005/006: 始终更新 sceneName，确保多→单场景降级后 docToTimeline 的 else 分支有数据
    const scenes = safeArray<Record<string, unknown>>(timelineData.scenes);
    const forcedMediaRefValues = collectForcedMediaRefValues(scenes, forcedMediaIds);
    if (scenes.length > 0) {
      const firstScene = scenes[0] as Record<string, unknown>;
      const baseFirstScene = baseTimeline
        ? safeArray<Record<string, unknown>>(baseTimeline.scenes)[0]
        : undefined;
      setSceneNameFromScene(meta, firstScene, baseFirstScene);
    }

    // 从 Y.Map 读取当前已有的 track/scene ID 集合
    const existingTrackIds = new Set<string>(getOrderedIds(trackOrderMap));
    const existingSceneIds = new Set<string>(getOrderedIds(sceneOrderMap));
    const currentTrackSceneMembership = readTrackSceneMembership(sceneTracksMap);
    const currentElementMembership = readElementMembership(
      trackElementOrderMaps,
      currentTrackSceneMembership,
    );

    // 预计算 push 数据中的所有 trackId 和 sceneId，用于后续孤立条目清理
    const pushedTrackIds = new Set<string>();
    const pushedSceneIds = new Set<string>();
    const pushedElementIdsAll = new Set<string>();
    const pushedTrackSceneMembership = new Map<string, string>();
    for (const scene of scenes) {
      const sid = scene.id as string;
      if (sid) pushedSceneIds.add(sid);
      for (const track of safeArray<Record<string, unknown>>(scene.tracks)) {
        const tid = track.id as string;
        if (tid) {
          pushedTrackIds.add(tid);
          if (sid) pushedTrackSceneMembership.set(tid, sid);
        }
        for (const element of safeArray<Record<string, unknown>>(track.elements)) {
          const eid = element.id as string;
          if (eid) pushedElementIdsAll.add(eid);
        }
      }
    }
    const isMultiScene = scenes.length > 1 || sceneOrderMap.size > 0;

    const baseElementMap = new Map<string, Record<string, unknown>>();
    const baseTrackMap = new Map<string, Record<string, unknown>>();
    const baseSceneMap = new Map<string, Record<string, unknown>>();
    const baseTrackIds = new Set<string>();
    const baseSceneIds = new Set<string>();
    const baseElementsByTrack = new Map<string, Set<string>>();
    const baseElementOrderByTrack = new Map<string, string[]>();
    const baseTrackSceneMembership = new Map<string, string>();
    const baseElementMembership = new Map<string, ElementMembership>();
    if (baseTimeline) {
      for (const bs of safeArray<Record<string, unknown>>(baseTimeline.scenes)) {
        const baseSceneId = bs.id as string | undefined;
        if (baseSceneId) {
          baseSceneIds.add(baseSceneId);
          baseSceneMap.set(baseSceneId, bs);
        }
        for (const bt of safeArray<Record<string, unknown>>(bs.tracks)) {
          const baseTrackId = bt.id as string | undefined;
          if (baseTrackId) {
            baseTrackMap.set(baseTrackId, bt);
            baseTrackIds.add(baseTrackId);
            if (baseSceneId) baseTrackSceneMembership.set(baseTrackId, baseSceneId);
          }
          const baseElementIds = new Set<string>();
          const baseElementOrder: string[] = [];
          for (const be of safeArray<Record<string, unknown>>(bt.elements)) {
            if (be.id) {
              const baseElementId = be.id as string;
              baseElementMap.set(baseElementId, be);
              baseElementIds.add(baseElementId);
              baseElementOrder.push(baseElementId);
              if (baseTrackId) {
                baseElementMembership.set(baseElementId, {
                  trackId: baseTrackId,
                  sceneId: baseSceneId,
                });
              }
            }
          }
          if (baseTrackId) baseElementsByTrack.set(baseTrackId, baseElementIds);
          if (baseTrackId) baseElementOrderByTrack.set(baseTrackId, baseElementOrder);
        }
      }
    }

    // 跟踪新的有序列表（用于 setOrderedIds）
    const newTrackOrderList: string[] = [...existingTrackIds];
    const newSceneOrderList: string[] = [...existingSceneIds];

    for (const scene of scenes) {
      const sceneId = (scene.id as string) ?? "";
      const sceneTracks = safeArray<Record<string, unknown>>(scene.tracks);
      const baseScene = baseSceneMap.get(sceneId);
      const currentSceneExists = scenesMap.has(sceneId) || existingSceneIds.has(sceneId) || sceneTracksMap.has(sceneId);
      const sceneMeta = { ...scene };
      delete sceneMeta.tracks;
      if (baseScene && !currentSceneExists && !sceneMetaChangedFromBase(sceneMeta, baseScene)) {
        continue;
      }

      if (isMultiScene && sceneId) {
        if (!existingSceneIds.has(sceneId)) {
          scenesMap.set(sceneId, createSceneMeta(scene, sceneId));
          newSceneOrderList.push(sceneId);
          existingSceneIds.add(sceneId);
        } else {
          const existing = scenesMap.get(sceneId) as Record<string, unknown> | undefined;
          const nextSceneMeta = baseScene && existing
            ? mergeSceneMetaFromBase(existing, scene, baseScene, sceneId)
            : {
                ...(existing ?? {}),
                id: sceneId,
                name: scene.name ?? existing?.name ?? "场景",
                isMain: scene.isMain ?? existing?.isMain ?? false,
                updatedAt: new Date().toISOString(),
              };
          if (!deepEqual(existing, nextSceneMeta)) {
            scenesMap.set(sceneId, nextSceneMeta);
          }
        }

        let sceneTrackIds = sceneTracksMap.get(sceneId) as Y.Array<string> | undefined;
        const existingSceneTrackSet = new Set<string>();
        if (sceneTrackIds) {
          for (let i = 0; i < sceneTrackIds.length; i++) existingSceneTrackSet.add(sceneTrackIds.get(i));
        } else {
          sceneTrackIds = new Y.Array<string>();
          sceneTracksMap.set(sceneId, sceneTrackIds);
        }
        for (const track of sceneTracks) {
          const tid = track.id as string;
          if (!tid || existingSceneTrackSet.has(tid)) continue;
          const baseSceneId = baseTrackSceneMembership.get(tid);
          const currentSceneId = currentTrackSceneMembership.get(tid);
          const agentMovedTrack = Boolean(baseSceneId && sceneId && baseSceneId !== sceneId);
          const currentTrackExists = tracksMap.has(tid) || existingTrackIds.has(tid) || Boolean(currentSceneId);
          const trackMeta = { ...track };
          delete trackMeta.elements;
          if (baseSceneId && !agentMovedTrack && currentSceneId && currentSceneId !== baseSceneId) {
            continue;
          }
          if (
            baseSceneId &&
            !agentMovedTrack &&
            !currentTrackExists &&
            !trackMetaChangedFromBase(trackMeta, baseTrackMap.get(tid))
          ) {
            continue;
          }
          sceneTrackIds.push([tid]);
          existingSceneTrackSet.add(tid);
        }
      } else {
        if (scene.name) setSceneNameFromScene(meta, scene, baseScene);
      }

      for (const track of sceneTracks) {
        const trackId = track.id as string;
        if (!trackId) continue;

        const { elements: _els, ...trackMeta } = track;
        const baseTrack = baseTrackMap.get(trackId);
        const baseTrackSceneId = baseTrackSceneMembership.get(trackId);
        const currentTrackSceneId = currentTrackSceneMembership.get(trackId);
        const agentMovedTrack = Boolean(baseTrackSceneId && sceneId && baseTrackSceneId !== sceneId);
        const currentTrackExists = tracksMap.has(trackId) || existingTrackIds.has(trackId) || Boolean(currentTrackSceneId);
        if (
          baseTrack &&
          !currentTrackExists &&
          !agentMovedTrack &&
          !trackMetaChangedFromBase(trackMeta, baseTrack)
        ) {
          continue;
        }

        const existingTrackMeta = tracksMap.get(trackId) as Record<string, unknown> | undefined;
        if (existingTrackMeta && baseTimeline) {
          if (baseTrack) {
            const merged = { ...existingTrackMeta };
            for (const [key, newVal] of Object.entries(trackMeta)) {
              if (key === "elements" || key === "id") continue;
              if (!deepEqual((baseTrack as Record<string, unknown>)[key], newVal)) merged[key] = newVal;
            }
            tracksMap.set(trackId, merged);
          } else {
            tracksMap.set(trackId, trackMeta);
          }
        } else {
          if (!deepEqual(tracksMap.get(trackId), trackMeta)) {
            tracksMap.set(trackId, trackMeta);
          }
        }

        // step2: 新增 track 时同步写入 trackOrderMap
        if (!existingTrackIds.has(trackId)) {
          newTrackOrderList.push(trackId);
          existingTrackIds.add(trackId);
        }

        const elArray = safeArray<Record<string, unknown>>(_els);
        const pushedElementIds = new Set<string>();
        const elOrderMap = getOrCreateElementOrderMap(trackElementOrderMaps, trackId);
        const existingElIds = new Set<string>(getOrderedIds(elOrderMap));
        const newElOrderList: string[] = [...existingElIds];

        for (const el of elArray) {
          const elId = el.id as string;
          if (!elId) continue;
          pushedElementIds.add(elId);

          const baseElement = baseElementMap.get(elId);
          const baseMembership = baseElementMembership.get(elId);
          const pushedMembership: ElementMembership = {
            trackId,
            sceneId: sceneId || undefined,
          };
          const currentMembership = currentElementMembership.get(elId);
          const agentMovedElement = Boolean(
            baseMembership && !sameElementMembership(baseMembership, pushedMembership),
          );
          const agentChangedElement = baseElement
            ? !deepEqual(normalizeElementForCompare(el), normalizeElementForCompare(baseElement))
            : true;
          const liveMovedOrDeletedElement = Boolean(
            baseMembership &&
            !agentMovedElement &&
            (!currentMembership || !sameElementMembership(currentMembership, baseMembership)),
          );
          const liveMovedElementAwayFromAgentTarget = Boolean(
            baseMembership &&
            currentMembership &&
            !sameElementMembership(currentMembership, baseMembership) &&
            !sameElementMembership(currentMembership, pushedMembership),
          );
          if (liveMovedOrDeletedElement && !agentChangedElement) {
            continue;
          }

          const existingYMap = elementsMap.get(elId);
          if (existingYMap instanceof Y.Map) {
            const currentMediaId = existingYMap.get("mediaId");
            const pushedMediaId = el.mediaId;
            const agentChangedMediaId = baseElement
              ? !deepEqual(baseElement.mediaId, pushedMediaId)
              : true;
            const mediaIdChangedOnlyInLive = (
              !agentChangedMediaId &&
              pushedMediaId !== undefined &&
              !deepEqual(currentMediaId, pushedMediaId)
            );
            const forceKeys = !mediaIdChangedOnlyInLive && shouldForceResyncMediaRefsForElement(el, forcedMediaIds)
              ? new Set(["fileUrl", "mediaPropsHash"])
              : undefined;
            const skipKeys = mediaIdChangedOnlyInLive
              ? new Set(["fileUrl", "mediaPropsHash"])
              : undefined;
            mergePropsIntoYMap(existingYMap, el, baseElementMap.get(elId), forceKeys, skipKeys);
          } else {
            if (baseMembership && !agentMovedElement) {
              continue;
            }
            const newYMap = new Y.Map<unknown>();
            for (const [key, value] of Object.entries(el)) {
              if (SKIP_ELEMENT_KEYS.has(key)) continue;
              if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                const nested = new Y.Map<unknown>();
                for (const [nk, nv] of Object.entries(value as Record<string, unknown>)) nested.set(nk, nv);
                newYMap.set(key, nested);
              } else {
                newYMap.set(key, value);
              }
            }
            elementsMap.set(elId, newYMap);
          }

          // step2: 新增 element 时同步写入 elOrderMap
          const shouldJoinPushedTrack = !baseMembership ||
            (agentMovedElement && !liveMovedElementAwayFromAgentTarget) ||
            sameElementMembership(currentMembership, pushedMembership);
          if (!existingElIds.has(elId) && shouldJoinPushedTrack) {
            newElOrderList.push(elId);
            existingElIds.add(elId);
          }
        }

        if (baseTimeline) {
          const deletedElementIds = new Set<string>();
          const baseElementIds = baseElementsByTrack.get(trackId) ?? new Set<string>();
          for (const elId of [...existingElIds]) {
            if (!baseElementIds.has(elId)) continue;
            if (pushedElementIds.has(elId)) continue;
            if (pushedElementIdsAll.has(elId)) {
              deletedElementIds.add(elId);
              continue;
            }
            const baseMembership = baseElementMembership.get(elId);
            const currentMembership = currentElementMembership.get(elId);
            const stillInBaseMembership = Boolean(
              baseMembership &&
              currentMembership &&
              sameElementMembership(currentMembership, baseMembership) &&
              elementOnlyBelongsToTrack(trackElementOrderMaps, elId, trackId),
            );
            if (
              !stillInBaseMembership ||
              elementHasOtherTrackMembership(trackElementOrderMaps, elId, trackId)
            ) {
              deletedElementIds.add(elId);
              continue;
            }
            if (yElementMatchesBase(elementsMap, elId, baseElementMap.get(elId))) {
              elementsMap.delete(elId);
              deletedElementIds.add(elId);
            }
          }
          if (deletedElementIds.size > 0) {
            for (const elId of deletedElementIds) existingElIds.delete(elId);
          }
        }

        // step3: 将更新后的 element 顺序写回 Y.Map（仅 key 级增量操作）
        setOrderedIds(elOrderMap, newElOrderList.filter(elId => existingElIds.has(elId)));
      }
    }

    // 防护：空 scenes push 不应清空已有轨道数据
    if (pushedTrackIds.size === 0 && existingTrackIds.size > 0) {
      console.warn(
        "[VideoDB] mergeTimelineIntoDoc: pushedTrackIds is empty but doc has " +
        `${existingTrackIds.size} existing tracks — skipping orphan cleanup to prevent data loss`,
      );
    } else {
      const canDeleteBaseSceneById = new Map<string, boolean>();
      if (baseTimeline && pushedSceneIds.size > 0) {
        for (const sid of [...existingSceneIds]) {
          if (!baseSceneIds.has(sid) || pushedSceneIds.has(sid)) continue;
          canDeleteBaseSceneById.set(sid, liveSceneMatchesBaseForDeletion(
            scenesMap,
            sceneTracksMap,
            tracksMap,
            elementsMap,
            trackElementOrderMaps,
            currentTrackSceneMembership,
            sid,
            baseSceneMap.get(sid),
            baseTrackMap,
            baseTrackSceneMembership,
            baseElementOrderByTrack,
            baseElementMap,
          ));
        }
      }

      // 清理 trackOrderMap：删除不再出现在 push 数据中的 trackId
      const deletedTrackIds = new Set<string>();
      for (const tid of [...existingTrackIds]) {
        const shouldDelete = baseTimeline
          ? baseTrackIds.has(tid) && !pushedTrackIds.has(tid)
          : !pushedTrackIds.has(tid);
        if (!shouldDelete) continue;
        if (baseTimeline) {
          const baseTrackSceneId = baseTrackSceneMembership.get(tid);
          if (
            baseTrackSceneId &&
            baseSceneIds.has(baseTrackSceneId) &&
            !pushedSceneIds.has(baseTrackSceneId) &&
            canDeleteBaseSceneById.get(baseTrackSceneId) === false
          ) {
            continue;
          }
          const canDelete = liveTrackMatchesBaseForDeletion(
            tracksMap,
            elementsMap,
            trackElementOrderMaps,
            currentTrackSceneMembership,
            tid,
            baseTrackMap.get(tid),
            baseTrackSceneMembership.get(tid),
            baseElementOrderByTrack.get(tid) ?? [],
            baseElementMap,
          );
          if (!canDelete) continue;
        }
        deletedTrackIds.add(tid);
      }

      const finalTrackIds = newTrackOrderList.filter(tid => !deletedTrackIds.has(tid));
      setOrderedIds(trackOrderMap, finalTrackIds);

      for (const tid of deletedTrackIds) {
        // 清理该 track 的 elements
        const elOrderMap = trackElementOrderMaps.get(tid) as Y.Map<number> | undefined;
        if (elOrderMap instanceof Y.Map) {
          const elIds = getOrderedIds(elOrderMap);
          for (const eid of elIds) {
            if (eid && !pushedElementIdsAll.has(eid)) elementsMap.delete(eid);
          }
          trackElementOrderMaps.delete(tid);
        }
        tracksMap.delete(tid);
      }

      // 清理 sceneOrderMap：删除不再出现在 push 数据中的 sceneId（仅多场景模式）
      if (pushedSceneIds.size > 0) {
        const deletedSceneIds = new Set<string>();
        for (const sid of [...existingSceneIds]) {
          const shouldDelete = baseTimeline
            ? baseSceneIds.has(sid) && !pushedSceneIds.has(sid)
            : !pushedSceneIds.has(sid);
          if (!shouldDelete) continue;
          if (baseTimeline && canDeleteBaseSceneById.get(sid) === false) continue;
          deletedSceneIds.add(sid);
        }

        const finalSceneIds = newSceneOrderList.filter(sid => !deletedSceneIds.has(sid));
        setOrderedIds(sceneOrderMap, finalSceneIds);

        for (const sid of deletedSceneIds) {
          scenesMap.delete(sid);
          sceneTracksMap.delete(sid);
        }
      }

      // 清理 sceneTracksMap 中各 scene 的孤立 trackId
      sceneTracksMap.forEach((val: unknown, sceneId: string) => {
        if (!(val instanceof Y.Array)) return;
        const arr = val as Y.Array<string>;
        for (let i = arr.length - 1; i >= 0; i--) {
          const trackId = arr.get(i);
          const pushedSceneId = pushedTrackSceneMembership.get(trackId);
          const baseSceneId = baseTrackSceneMembership.get(trackId);
          const agentMovedTrack = Boolean(
            pushedSceneId &&
            pushedSceneId !== sceneId &&
            (!baseSceneId || baseSceneId !== pushedSceneId),
          );
          if (deletedTrackIds.has(trackId) || agentMovedTrack) arr.delete(i, 1);
        }
      });
    }

    // step3+step4: 将最终的 track/scene 顺序写回 Y.Map（已在 cleanup 分支中完成）
    // 若 pushedTrackIds 为空（跳过 cleanup），仍需写入当前 track 顺序
    if (pushedTrackIds.size === 0 && existingTrackIds.size > 0) {
      setOrderedIds(trackOrderMap, newTrackOrderList);
    }
    if (pushedSceneIds.size === 0 && existingSceneIds.size > 0) {
      setOrderedIds(sceneOrderMap, newSceneOrderList);
    }

    applyForcedMediaRefsToExistingElements(elementsMap, forcedMediaRefValues);
  });
}

function mergePropsIntoYMap(
  ymap: Y.Map<unknown>,
  newData: Record<string, unknown>,
  baseData?: Record<string, unknown>,
  forceKeys?: Set<string>,
  skipKeys?: Set<string>,
): void {
  for (const [key, newValue] of Object.entries(newData)) {
    if (SKIP_ELEMENT_KEYS.has(key)) continue;
    if (skipKeys?.has(key)) continue;
    if (baseData && key in baseData && deepEqual(baseData[key], newValue) && !forceKeys?.has(key)) continue;

    const existing = ymap.get(key);
    if (typeof newValue === "object" && newValue !== null && !Array.isArray(newValue)) {
      if (existing instanceof Y.Map) {
        mergePropsIntoYMap(
          existing,
          newValue as Record<string, unknown>,
          baseData?.[key] as Record<string, unknown> | undefined,
          forceKeys,
          skipKeys,
        );
      } else {
        const nested = new Y.Map<unknown>();
        for (const [nk, nv] of Object.entries(newValue as Record<string, unknown>)) nested.set(nk, nv);
        ymap.set(key, nested);
      }
    } else {
      if (!deepEqual(existing, newValue)) ymap.set(key, newValue);
    }
  }
}

/**
 * 从 Y.Doc 重建 TProject JSON
 *
 * step3+step4: 读操作切到 Y.Map，fallback 到旧 Y.Array（向后兼容）
 */
function docToTimeline(doc: Y.Doc): Record<string, unknown> {
  const tracksMap = doc.getMap("tracks");
  const elementsMap = doc.getMap("elements");
  const trackOrderMap = doc.getMap<number>("trackOrderMap");
  const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
  const settingsMap = doc.getMap("settings");
  const meta = doc.getMap("meta");
  const scenesMap = doc.getMap("scenes");
  const sceneOrderMap = doc.getMap<number>("sceneOrderMap");
  const sceneTracksMap = doc.getMap("sceneTracks");

  // fallback: 旧文档可能只有 Y.Array，没有 Y.Map
  const legacyTrackOrder = doc.getArray<string>("trackOrder");
  const legacySceneOrder = doc.getArray<string>("sceneOrder");
  const legacyTrackElements = doc.getMap("trackElements");

  // VID-008: 使用 meta 中存储的稳定 updatedAt，避免 digest 每次比较都不同
  const storedUpdatedAt = (meta.get("updatedAt") as string) ?? new Date().toISOString();
  const now = storedUpdatedAt;

  // step3: 优先用 Y.Map，fallback 到 Y.Array（向后兼容旧文档）
  const useMapForTracks = trackOrderMap.size > 0;
  const useMapForScenes = sceneOrderMap.size > 0;

  const isMultiScene = useMapForScenes
    ? sceneOrderMap.size > 0
    : legacySceneOrder.length > 0;

  /**
   * step3: 从 Y.Map 或 Y.Array 读取 element 列表（优先 Y.Map）
   */
  function getElementsForTrack(trackId: string): Record<string, unknown>[] {
    const elArr: Record<string, unknown>[] = [];
    let elIds: string[];

    const elOrderMap = trackElementOrderMaps.get(trackId) as Y.Map<number> | undefined;
    if (elOrderMap instanceof Y.Map && elOrderMap.size > 0) {
      // step3: 优先读 Y.Map
      elIds = getOrderedIds(elOrderMap);
    } else {
      // fallback: 旧文档读 Y.Array
      const legacyOrder = legacyTrackElements.get(trackId) as Y.Array<string> | undefined;
      elIds = legacyOrder ? legacyOrder.toArray() : [];
    }

    const seenEl = new Set<string>();
    for (const elId of elIds) {
      if (seenEl.has(elId)) continue;
      seenEl.add(elId);
      const elRaw = elementsMap.get(elId);
      if (!elRaw) continue;
      elArr.push(elRaw instanceof Y.Map ? yMapToPlain(elRaw) : elRaw as Record<string, unknown>);
    }
    return elArr;
  }

  /**
   * step3: 从 track ID 列表（去重后）构建 track 数组
   */
  function buildTracksFromIds(rawIds: string[]): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    for (const trackId of rawIds) {
      if (seen.has(trackId)) continue;
      seen.add(trackId);
      const trackMeta = tracksMap.get(trackId) as Record<string, unknown> | undefined;
      if (!trackMeta) continue;
      result.push({ ...trackMeta, elements: getElementsForTrack(trackId) });
    }
    return result;
  }

  let builtScenes: Record<string, unknown>[];

  if (isMultiScene) {
    builtScenes = [];

    // step3: 优先读 sceneOrderMap，fallback 到 sceneOrder（Y.Array）
    const sceneIds: string[] = useMapForScenes
      ? getOrderedIds(sceneOrderMap)
      : legacySceneOrder.toArray();

    const seenScenes = new Set<string>();
    for (let si = 0; si < sceneIds.length; si++) {
      const sceneId = sceneIds[si];
      if (seenScenes.has(sceneId)) continue;
      seenScenes.add(sceneId);
      const sceneMeta = scenesMap.get(sceneId) as Record<string, unknown> | undefined;
      const sceneTrackIds = sceneTracksMap.get(sceneId) as Y.Array<string> | undefined;
      builtScenes.push({
        id: sceneId, name: sceneMeta?.name ?? "场景", isMain: sceneMeta?.isMain ?? (si === 0),
        tracks: buildTracksFromIds(sceneTrackIds ? sceneTrackIds.toArray() : []),
        bookmarks: sceneMeta?.bookmarks ?? [], createdAt: sceneMeta?.createdAt ?? now, updatedAt: sceneMeta?.updatedAt ?? now,
      });
    }
  } else {
    const sceneId = (meta.get("currentSceneId") as string) ?? "main";

    // step3: 优先读 trackOrderMap，fallback 到 trackOrder（Y.Array）
    const trackIds: string[] = useMapForTracks
      ? getOrderedIds(trackOrderMap)
      : legacyTrackOrder.toArray();

    builtScenes = [{
      id: sceneId, name: (meta.get("sceneName") as string) ?? "主场景", isMain: true,
      tracks: buildTracksFromIds(trackIds), bookmarks: [],
      createdAt: (meta.get("createdAt") as string) ?? now, updatedAt: now,
    }];
  }

  return {
    metadata: {
      id: (meta.get("projectId") as string) ?? "", name: (meta.get("name") as string) ?? "",
      duration: (meta.get("duration") as number) ?? 0,
      createdAt: (meta.get("createdAt") as string) ?? now, updatedAt: now,
    },
    scenes: builtScenes,
    currentSceneId: (meta.get("currentSceneId") as string) ?? (builtScenes[0] as Record<string, unknown>)?.id ?? "main",
    settings: {
      fps: (settingsMap.get("fps") as number) ?? 30,
      canvasSize: { width: (settingsMap.get("width") as number) ?? 1920, height: (settingsMap.get("height") as number) ?? 1080 },
      background: { type: (settingsMap.get("bgType") as string) ?? "color", color: (settingsMap.get("bgColor") as string) ?? "#000000" },
    },
    version: (meta.get("version") as number) ?? 1,
  };
}

/**
 * 清除 Y.Doc 中所有 type=text 的轨道及其 elements。
 */
function clearSubtitleTracksInDoc(doc: Y.Doc): number {
  const tracksMap = doc.getMap("tracks");
  const elementsMap = doc.getMap("elements");
  const trackOrderMap = doc.getMap<number>("trackOrderMap");
  const trackElementOrderMaps = doc.getMap("trackElementOrderMaps");
  const sceneTracksMap = doc.getMap("sceneTracks");

  let removedCount = 0;
  doc.transact(() => {
    const textTrackIds: string[] = [];
    tracksMap.forEach((val: unknown, trackId: string) => {
      if ((val as Record<string, unknown>)?.type === "text") textTrackIds.push(trackId);
    });
    const textTrackIdSet = new Set(textTrackIds);

    for (const trackId of textTrackIds) {
      const elOrderMap = trackElementOrderMaps.get(trackId) as Y.Map<number> | undefined;
      if (elOrderMap instanceof Y.Map) {
        const elIds = getOrderedIds(elOrderMap);
        for (const elId of elIds) { if (elId) { elementsMap.delete(elId); removedCount++; } }
        trackElementOrderMaps.delete(trackId);
      }
      tracksMap.delete(trackId);
      // step4: 从 trackOrderMap（Y.Map）删除，O(1) key 级 delete
      trackOrderMap.delete(trackId);
    }

    sceneTracksMap.forEach((val: unknown) => {
      if (val instanceof Y.Array) {
        for (let i = val.length - 1; i >= 0; i--) { if (textTrackIdSet.has(val.get(i) as string)) val.delete(i, 1); }
      }
    });
  });
  return removedCount;
}

// ─── BaseCollabDatabase 子类 ────────────────────────────

export class VideoDatabase extends BaseCollabDatabase {
  private readonly _pendingTimeline = new Map<string, Record<string, unknown>>();

  /**
   * VID-L4: timeline 双哈希 digest 缓存（FNV-1a + djb2）。
   * 直接遍历 Y.Doc map 结构计算 64-bit 碰撞抗性哈希，
   * 替代 CI-005 的 JSON.stringify 全量字符串比较。
   * 100+ 轨道 × 多元素场景下性能提升约 20-50x（无变更时跳过 docToTimeline + JSON.stringify 两步）。
   */
  private readonly _timelineDigest = new Map<string, string>();

  /**
   * VID-L4: buildPersistPayload 时暂存的 digest，供 onStoreSuccess 复用。
   * 确保存储的基准 digest 精确反映已持久化的 Y.Doc 状态，
   * 而非 HTTP 期间到达的新 update 状态，避免丢失并发编辑。
   */
  private readonly _pendingDigest = new Map<string, string>();

  protected getPrefix(): string { return "video:"; }
  protected getResourceType(): string { return "video"; }
  protected getModuleLabel(): string { return "VideoDB"; }

  protected applySnapshotToDoc(initDoc: Y.Doc, snapshot: Record<string, unknown>): void {
    applyTimelineToDoc(initDoc, snapshot.timeline_data as Record<string, unknown> | null);
  }

  protected onSnapshotLoaded(documentName: string, initDoc: Y.Doc, _snapshot: Record<string, unknown>): void {
    const timeline = docToTimeline(initDoc);
    this.snapshotCache.set(documentName, timeline);
    this._timelineDigest.set(documentName, computeTimelineDigest(initDoc));
  }

  /**
   * step4: prepareYDocForMerge 移除 Y.Array 清空操作。
   * trackOrderMap/sceneOrderMap 是 Y.Map，key 级 LWW 合并天然幂等，
   * applySnapshotToDoc 调用 setOrderedIds 会全量覆盖，不需要预清空。
   */
  protected prepareYDocForMerge(_ydoc: Y.Doc): void {
    // Y.Map 不需要预清空：applyTimelineToDoc 调用 setOrderedIds 会全量覆盖旧 key。
    // sceneTracks（Y.Array）仍存在但在 applyTimelineToDoc 中通过 delete+push 复用同一实例，
    // 因此此处也无需预清空。
  }

  protected buildPersistPayload(
    ydoc: Y.Doc,
    documentName: string,
    context: Record<string, unknown>,
  ): PersistPayload | null {
    const lastSnapshot = this.snapshotCache.get(documentName) as Record<string, unknown> | undefined;

    // VID-L4: 双哈希 digest 快速跳过 — 直接遍历 Y.Doc maps 计算哈希，
    // 无变更时完全跳过 docToTimeline + JSON.stringify 两步 O(N) 开销
    const currentDigest = computeTimelineDigest(ydoc);
    const lastDigest = this._timelineDigest.get(documentName);
    if (lastSnapshot && lastDigest === currentDigest) {
      this._pendingTimeline.delete(documentName);
      this._pendingDigest.delete(documentName);
      return null;
    }

    const timelineData = docToTimeline(ydoc);

    if (!lastSnapshot) {
      console.log(`[VideoDB] First store for ${documentName}, performing full persist`);
    }

    this._pendingTimeline.set(documentName, timelineData);
    this._pendingDigest.set(documentName, currentDigest);

    const meta = ydoc.getMap("meta");
    const version = (meta.get("version") as number) ?? undefined;
    const { editorType, editorId, editorName } = extractEditorInfo(context);
    const opId = `video_collab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return {
      changes: {
        timeline_data: timelineData,
        ...(version != null && { base_version: version }),
      },
      op_id: opId,
      editor_type: editorType,
      editor_id: editorId,
      editor_name: editorName,
    };
  }

  protected onStoreSuccess(ydoc: Y.Doc, documentName: string, result: unknown): void {
    const newVersion = (result as Record<string, unknown>)?.version as number | undefined;
    if (newVersion != null) {
      ydoc.getMap("meta").set("version", newVersion);
    }
    const cached = this._pendingTimeline.get(documentName);
    const pendingDigest = this._pendingDigest.get(documentName);
    if (cached) {
      this._pendingTimeline.delete(documentName);
      this._pendingDigest.delete(documentName);
      if (newVersion != null) {
        cached.version = newVersion;
      }
      this.snapshotCache.set(documentName, cached);
      // VID-L4: 使用 buildPersistPayload 时暂存的 digest（排除 version），
      // 精确反映已持久化的内容状态，避免 HTTP 期间新 update 污染基准
      this._timelineDigest.set(documentName, pendingDigest ?? computeTimelineDigest(ydoc));
    } else {
      const timeline = docToTimeline(ydoc);
      this.snapshotCache.set(documentName, timeline);
      this._timelineDigest.set(documentName, computeTimelineDigest(ydoc));
    }
  }

  protected onStoreConflict(ydoc: Y.Doc, documentName: string, conflictResult: Record<string, unknown>): void {
    const serverVersion = conflictResult.current_version as number | undefined;
    if (serverVersion != null) {
      ydoc.getMap("meta").set("version", serverVersion);
    }
    this._pendingDigest.delete(documentName);
    this._pendingTimeline.delete(documentName);
  }

  protected clearSnapshot(documentName: string): void {
    this._timelineDigest.delete(documentName);
    this._pendingTimeline.delete(documentName);
    this._pendingDigest.delete(documentName);
  }

  protected logStoreSuccess(resourceId: string, result: unknown, latencyMs: number): void {
    const r = result as Record<string, unknown> | undefined;
    console.log(
      `[VideoDB] Persisted timeline for video ${resourceId}: ` +
      `version=${r?.version} (${latencyMs}ms)`,
    );
  }
}

export function createVideoDatabase() {
  return new VideoDatabase();
}

export { applyTimelineToDoc, mergeTimelineIntoDoc, docToTimeline, clearSubtitleTracksInDoc, computeTimelineDigest };
