/**
 * RecordingRegistry —— 活跃录制的「按 tab 键」轻量登记表（BR-8 P3c 收尾 / run 下沉首付）。
 *
 * 起因：Electron `/record/*` 路由原先用模块级 `Map<tabId, …>` 跨请求记「这个 tab 正在录」，
 * 违反 WS-B「route 层无跨请求 Map」不变量。把这份**纯数据**登记表收编进 browser-core
 * 共享 runtime（与 RefCache / NetworkLog 同模式），route 不再持有跨请求 Map。
 *
 * ⚠️ electron-free：只存 `tabId → {runId, startedAt}`，不碰 Electron/Playwright。
 * 一个进程只跑一个运行时，单例按 tabId 分桶不会串。
 *
 * 这是「run 概念下沉 runtime」的**最小首付**——真正承载 view/observation/job-cancel 的
 * RunSessionManager 仍是 Electron-only（耦合 ViewFactory/CrawlspaceContextHub），其完整下沉
 * 留给 BR-10（见 `docs/agent/browser-br-8-design.md` §5 与本切片 PR 说明）。
 */

/** 单条活跃录制的元数据（key = tabId，故不重复存 tabId）。 */
export interface ActiveRecordingEntry {
  runId: string
  startedAt: number
}

export class RecordingRegistry {
  private active = new Map<string, ActiveRecordingEntry>()

  get(tabId: string): ActiveRecordingEntry | undefined {
    return this.active.get(tabId)
  }

  has(tabId: string): boolean {
    return this.active.has(tabId)
  }

  set(tabId: string, entry: ActiveRecordingEntry): void {
    this.active.set(tabId, entry)
  }

  delete(tabId: string): boolean {
    return this.active.delete(tabId)
  }

  clear(): void {
    this.active.clear()
  }
}

let sharedRecordingRegistry: RecordingRegistry | null = null

/** 进程级共享的活跃录制登记表。 */
export function getSharedRecordingRegistry(): RecordingRegistry {
  if (!sharedRecordingRegistry) sharedRecordingRegistry = new RecordingRegistry()
  return sharedRecordingRegistry
}

/** 重置共享登记表（仅供测试隔离用）。 */
export function resetSharedRecordingRegistry(): void {
  sharedRecordingRegistry = null
}
