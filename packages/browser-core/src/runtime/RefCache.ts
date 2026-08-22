/**
 * RefCache —— 常驻元素引用缓存（BR-8 WS-B / P3a）。
 *
 * compact snapshot 把可交互元素压成 `e1/e2/...` 短引用（eN），并记下每个 eN 对应的
 * 真实 `selector`。RefCache 按 tabId 分桶把这份 `eN → selector` 映射沉淀下来，供随后的
 * `act` 把 action 里的 `ref`/`toRef` 回解成 `selector`/`toSelector`——于是 Agent 能用
 * 「snapshot 给的 eN」直接驱动 act，不必自己写 CSS/XPath。
 *
 * BW-1：每个 RefEntry 额外存 `semantic`（role/name/nth）与可选 `backendId` 快路径句柄；
 * xpath/selector 失效时 ActionRunner 按语义指纹自动重定位，不必整轮重 snapshot。
 *
 * 收编动机：此前这份状态只住在 Electron route 层（`interaction.ts` 的模块级 Map），
 * Daemon 没有 → daemon `act` 收到 snapshot 的 eN 无法回解。按 P2 的 NetworkLog/ConsoleLog
 * 同样模式收进 browser-core 的共享单例后，两端 route 都填同一份、查同一份，eN 回解双端一致。
 *
 * ⚠️ electron-free / 零副作用：只持有数据结构 + 纯逻辑，不 import 任何运行时
 * （不碰 electron / playwright / 两端 route），可被两端共同喂数据。
 *
 * 进程语义：一个进程只跑一个运行时（Electron 或 Daemon），共享单例按 tabId 分桶不会串。
 */

import type { SemanticFingerprint } from './ref-semantic';

export type { SemanticFingerprint } from './ref-semantic';

/**
 * 一个元素引用解析项。形状与既有 Electron route 的 `RefEntry` 对齐：
 * - `selector`：回解 act 用的真实选择器（必有）。
 * - `xpath` / `backendId`：快路径元数据（BR-17 精确 xpath / AX backend 句柄）。
 * - `semantic`：BW-1 语义指纹（role/name/nth），selector 失效时重定位。
 * - `boundingBox`：可选元数据。
 * - `timestamp`：填充时刻，便于诊断/将来做过期淘汰。
 */
export interface RefEntry {
  selector: string;
  frameId?: string;
  xpath?: string;
  backendId?: string;
  semantic?: SemanticFingerprint;
  boundingBox?: { x: number; y: number; width: number; height: number };
  timestamp?: number;
}

/** 空 tabId 时的兜底键，与 Electron route 既有口径（`tabId || '__default'`）一致。 */
const DEFAULT_TAB_KEY = '__default';

export class RefCache {
  private readonly tabs = new Map<string, Map<string, RefEntry>>();

  private key(tabId?: string | null): string {
    return tabId || DEFAULT_TAB_KEY;
  }

  /** 取某 tab 的 `ref → entry` 映射；不存在则建空表并返回（便于直接写入）。 */
  get(tabId?: string | null): Map<string, RefEntry> {
    const k = this.key(tabId);
    let m = this.tabs.get(k);
    if (!m) {
      m = new Map();
      this.tabs.set(k, m);
    }
    return m;
  }

  has(tabId?: string | null): boolean {
    return this.tabs.has(this.key(tabId));
  }

  /** 写入/覆盖单个引用。 */
  set(tabId: string | null | undefined, ref: string, entry: RefEntry): void {
    this.get(tabId).set(ref, entry);
  }

  /**
   * 用一组新引用整体替换某 tab 的表（先清后填）。
   * 对齐 Electron snapshot 填充的既有语义：每次 compact snapshot 完成即 `clear()` 再灌入，
   * 保证表里只反映「最近一次 snapshot」的元素集合，不残留上一页的 eN。
   */
  replace(tabId: string | null | undefined, refs: Iterable<readonly [string, RefEntry]>): void {
    const m = this.get(tabId);
    m.clear();
    for (const [ref, entry] of refs) m.set(ref, entry);
  }

  /** 清空某 tab 的全部引用（tab 关闭等生命周期事件时调用）。 */
  clear(tabId?: string | null): void {
    this.tabs.delete(this.key(tabId));
  }

  /** 清空所有 tab（主要给测试隔离用）。 */
  clearAll(): void {
    this.tabs.clear();
  }

  /** 某 tab 当前缓存的引用条数（主要给单测/可观测用）。 */
  size(tabId?: string | null): number {
    return this.tabs.get(this.key(tabId))?.size ?? 0;
  }

  /**
   * 把一批 action 里的 `ref`/`toRef` 回解成 `selector`/`toSelector`。
   *
   * 行为与 Electron route 既有 `resolveRefsInActions` 逐字段一致：
   * - 仅当 action 已带 `ref` 且**未**显式带 `selector` 时才回解（显式 selector 优先）。
   * - `toRef → toSelector` 同理（drag 等双目标 action）。
   * - 缓存里查不到该 ref（如该 tab 从未 snapshot）→ 原样透传，不报错。
   * - 不就地改入参：每个 action 浅拷贝后再补字段。
   */
  resolveRefsInActions<T extends Record<string, any>>(actions: T[], tabId?: string | null): T[] {
    if (!Array.isArray(actions)) return actions;
    const cache = this.tabs.get(this.key(tabId));
    if (!cache) return actions;
    return actions.map((action) => {
      const resolved: Record<string, any> = { ...action };
      if (resolved.ref && !resolved.selector) {
        const entry = cache.get(resolved.ref);
        if (entry) {
          resolved.selector = entry.selector;
          if (entry.frameId) resolved.frameId = entry.frameId;
          if (entry.semantic) resolved.refSemantic = entry.semantic;
        }
      }
      if (resolved.toRef && !resolved.toSelector) {
        const entry = cache.get(resolved.toRef);
        if (entry) {
          resolved.toSelector = entry.selector;
          if (entry.semantic) resolved.toRefSemantic = entry.semantic;
        }
      }
      return resolved as T;
    });
  }
}

let shared: RefCache | null = null;

/** 进程级共享元素引用缓存。 */
export function getSharedRefCache(): RefCache {
  if (!shared) shared = new RefCache();
  return shared;
}

/** 重置共享缓存（仅供测试隔离用）。 */
export function resetSharedRefCache(): void {
  shared = null;
}
