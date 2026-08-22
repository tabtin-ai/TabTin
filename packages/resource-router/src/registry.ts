/**
 * @tabtin/resource-router · registry
 *
 * 把所有 builtin / marketplace App 的 `manifest.opens` 字段聚合成
 *   - typeIndex:   ContextRefType → 按 priority desc 排好的 [{appId, priority}]
 *   - schemeIndex: scheme         → 同上
 *
 * 这是 RFC §9 决定的「ResourceRouter 是 ContextRegistry 的薄包装层」之一：
 * Router 不持有 handler 注册职责（那是 ContextRegistry 的事），只多两个倒排索引。
 *
 * 启动时聚合策略（W3 接 chat 闭环时实例化）：
 *   - builtin App: 构建期通过 import.meta.glob('packages/apps/* /app.json')
 *     聚合，渲染层启动时一次性 register。具体集成点在 W3 的
 *     `apps/tabtin-electron/src/renderer/src/components/context-space/registry/index.ts`
 *   - marketplace App: 通过 `useSpaceApps.loadSpaceApps` 动态 register
 *
 * 本包不直接读 manifest 文件——只接受调用方传入聚合好的数据。这避免
 * 协议层与文件系统耦合，便于测试。
 */

import type {
  ManifestOpens,
  ManifestOpensSchemeEntry,
  ManifestOpensTypeEntry,
  ResourcePointerType,
} from './types.js'

export interface RegisteredCandidate {
  appId: string
  priority: number
}

/**
 * 倒排索引。register / unregister 都是同步操作；查询走 sorted slice 的
 * shallow copy（不可变保护）。
 *
 * 排序规则（D2 优先级表第 4 层「manifest_default」内的相对排序）：
 *   1. priority desc
 *   2. priority 相同时 appId asc（字典序）——保证多次 register 顺序无关
 */
export class ResourceRouterRegistry {
  private readonly typeIndex = new Map<ResourcePointerType, RegisteredCandidate[]>()
  private readonly schemeIndex = new Map<string, RegisteredCandidate[]>()

  /**
   * 注册一个 App 的 opens 声明。
   * 同一个 (appId, type) / (appId, scheme) 组合可重复 register——后者覆盖前者
   * （便于 hot-reload 时 marketplace App 重装）。
   */
  register(appId: string, opens: ManifestOpens | undefined | null): void {
    if (!appId || typeof appId !== 'string') {
      throw new Error(`ResourceRouterRegistry.register: invalid appId ${String(appId)}`)
    }
    if (!opens) return

    for (const entry of opens.types ?? []) {
      this.registerTypeEntry(appId, entry)
    }
    for (const entry of opens.schemes ?? []) {
      this.registerSchemeEntry(appId, entry)
    }
  }

  /** 撤销一个 App 的所有 opens 声明（marketplace App 卸载时用）。 */
  unregister(appId: string): void {
    for (const [key, list] of this.typeIndex.entries()) {
      const filtered = list.filter((c) => c.appId !== appId)
      if (filtered.length === 0) {
        this.typeIndex.delete(key)
      } else {
        this.typeIndex.set(key, filtered)
      }
    }
    for (const [key, list] of this.schemeIndex.entries()) {
      const filtered = list.filter((c) => c.appId !== appId)
      if (filtered.length === 0) {
        this.schemeIndex.delete(key)
      } else {
        this.schemeIndex.set(key, filtered)
      }
    }
  }

  /** 查询能处理给定 ContextRefType 的所有候选（按 priority desc 排好的拷贝）。 */
  lookupByType(type: ResourcePointerType): RegisteredCandidate[] {
    const list = this.typeIndex.get(type)
    return list ? list.slice() : []
  }

  /**
   * 查询能处理给定 scheme 的所有候选。
   * scheme 必须以冒号结尾（与 URL.protocol / manifest 里声明的形态一致），
   * 例如 `'https:'` / `'mailto:'`。
   */
  lookupByScheme(scheme: string): RegisteredCandidate[] {
    const list = this.schemeIndex.get(scheme)
    return list ? list.slice() : []
  }

  /** 总注册项数（types + schemes 求和）；W2 北极星 2 用：≥ 20。 */
  size(): number {
    let total = 0
    for (const list of this.typeIndex.values()) total += list.length
    for (const list of this.schemeIndex.values()) total += list.length
    return total
  }

  /** 已注册的 ContextRefType 集合（便于 settings Panel 动态生成下拉项）。 */
  knownTypes(): ResourcePointerType[] {
    return Array.from(this.typeIndex.keys())
  }

  /** 已注册的 scheme 集合（便于 settings Panel 动态生成下拉项）。 */
  knownSchemes(): string[] {
    return Array.from(this.schemeIndex.keys())
  }

  /** 仅供测试 / debug：所有 (appId, type, priority) 三元组扁平视图。 */
  dumpForDebug(): {
    types: Array<{ type: ResourcePointerType; appId: string; priority: number }>
    schemes: Array<{ scheme: string; appId: string; priority: number }>
  } {
    const types: Array<{ type: ResourcePointerType; appId: string; priority: number }> = []
    for (const [type, list] of this.typeIndex.entries()) {
      for (const c of list) types.push({ type, appId: c.appId, priority: c.priority })
    }
    const schemes: Array<{ scheme: string; appId: string; priority: number }> = []
    for (const [scheme, list] of this.schemeIndex.entries()) {
      for (const c of list) schemes.push({ scheme, appId: c.appId, priority: c.priority })
    }
    return { types, schemes }
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private registerTypeEntry(appId: string, entry: ManifestOpensTypeEntry): void {
    if (!entry || typeof entry.type !== 'string' || !entry.type) {
      throw new Error(
        `ResourceRouterRegistry.register(${appId}): opens.types entry missing 'type'`,
      )
    }
    if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority)) {
      throw new Error(
        `ResourceRouterRegistry.register(${appId}): opens.types[${entry.type}].priority must be a finite number`,
      )
    }
    const list = this.typeIndex.get(entry.type) ?? []
    const filtered = list.filter((c) => c.appId !== appId)
    filtered.push({ appId, priority: entry.priority })
    sortCandidates(filtered)
    this.typeIndex.set(entry.type, filtered)
  }

  private registerSchemeEntry(appId: string, entry: ManifestOpensSchemeEntry): void {
    if (!entry || typeof entry.scheme !== 'string' || !entry.scheme) {
      throw new Error(
        `ResourceRouterRegistry.register(${appId}): opens.schemes entry missing 'scheme'`,
      )
    }
    if (!entry.scheme.endsWith(':')) {
      throw new Error(
        `ResourceRouterRegistry.register(${appId}): scheme '${entry.scheme}' must end with ':' to align with URL.protocol`,
      )
    }
    if (typeof entry.priority !== 'number' || !Number.isFinite(entry.priority)) {
      throw new Error(
        `ResourceRouterRegistry.register(${appId}): opens.schemes[${entry.scheme}].priority must be a finite number`,
      )
    }
    const list = this.schemeIndex.get(entry.scheme) ?? []
    const filtered = list.filter((c) => c.appId !== appId)
    filtered.push({ appId, priority: entry.priority })
    sortCandidates(filtered)
    this.schemeIndex.set(entry.scheme, filtered)
  }
}

function sortCandidates(list: RegisteredCandidate[]): void {
  list.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority // desc
    return a.appId < b.appId ? -1 : a.appId > b.appId ? 1 : 0
  })
}
