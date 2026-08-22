/**
 * FileHistoryRegistry —— per-threadId 的 FileHistoryService 缓存。
 *
 * 平台无关：host（Electron 主进程 / Daemon）各 new 一个 registry 实例，按业务对话
 * threadId 取/建 service（不存在才 new + init），让同一 thread 的多次 query 与子
 * agent fork **复用同一实例** —— snapshots 跨轮累积、跨轮回退才找得到 anchor。
 * 这正是它与 per-query 新建的 `readFileState` 的本质区别。
 *
 * 分工：`FileHistoryService` 管单 thread 的 ledger + 持久化；本类管多 thread 的
 * 生命周期（getOrCreate / get / remove）。设备端回退入口（Electron IPC /
 * Daemon action-bridge）通过 `get(threadId)` 拿到已建实例做 rewind / preview。
 */
import { FileHistoryService, canonicalizeWorkspaceRoot, peekFileHistoryWorkspaceRoot } from './FileHistoryService.js'
import type { FileHistoryLogger } from './types.js'

export interface FileHistoryRegistryOptions {
  /** 备份根目录，如 `~/.tabtin/file-history`。 */
  historyRoot: string
  logger: FileHistoryLogger
  /** 透传给每个 service 的内存 snapshot 上限。 */
  maxSnapshots?: number
  /**
   * 是否对每个 service 启用持久化（默认 `true`）。host 场景需要跨重启 / 同 thread
   * 多 query resume，故默认开；纯内存 / 测试可关。
   */
  persist?: boolean
}

export class FileHistoryRegistry {
  private readonly services = new Map<string, FileHistoryService>()
  /** in-flight 创建 promise，防并发 getOrCreate 同 threadId 建出两个实例。 */
  private readonly pending = new Map<string, Promise<FileHistoryService>>()
  /**
   * P1-3：in-flight 移除 promise（tombstone）。remove 期间 getOrCreate 先 await
   * 它再判定，避免"旧 service 还在 flush manifest，新 service 已重建并写同一
   * manifest"的 race。remove 内**先 flush 再删 Map**，删完才解 tombstone。
   */
  private readonly removing = new Map<string, Promise<void>>()

  constructor(private readonly opts: FileHistoryRegistryOptions) {}

  /**
   * 按 threadId 取/建。不存在才 new + `init()`（从 manifest resume）。
   *
   * P1-3：先等本 thread 的 in-flight 移除落定，避免和旧 service 的 flush 抢 manifest。
   * P1-2：命中缓存但 canonical workspaceRoot 变了（同 session 切了 TabCode 项目）→
   *   flush+seal 旧 service、按新 root 新建，避免旧 ledger 的相对路径 key 错位。
   *   （manifest 侧 root mismatch 由 `FileHistoryService.init` 兜底不复用。）
   */
  async getOrCreate(threadId: string, workspaceRoot: string): Promise<FileHistoryService> {
    // P1-3：等本 thread 的移除先完成（若有），再判定缓存状态。
    const removal = this.removing.get(threadId)
    if (removal) await removal

    const existing = this.services.get(threadId)
    if (existing) {
      if (existing.workspaceRoot === canonicalizeWorkspaceRoot(workspaceRoot)) return existing
      // P1-2：root 漂移 → 安全移除（flush 旧 + tombstone）后落到下方重建。
      this.opts.logger.warn(
        `[FileHistoryRegistry] workspaceRoot changed for thread ${threadId} ` +
          `(${existing.workspaceRoot} → ${canonicalizeWorkspaceRoot(workspaceRoot)}); sealing old service, recreating`,
      )
      await this.remove(threadId)
      // 移除期间若已有人并发重建，直接复用（极少见的 3 路 root 竞态不再追求绝对一致）。
      const recreated = this.services.get(threadId)
      if (recreated) return recreated
    }

    const inflight = this.pending.get(threadId)
    if (inflight) return inflight

    const p = (async () => {
      const svc = new FileHistoryService({
        threadId,
        workspaceRoot,
        historyRoot: this.opts.historyRoot,
        logger: this.opts.logger,
        maxSnapshots: this.opts.maxSnapshots,
        persist: this.opts.persist ?? true,
      })
      await svc.init()
      this.services.set(threadId, svc)
      this.pending.delete(threadId)
      return svc
    })()
    this.pending.set(threadId, p)
    try {
      return await p
    } catch (e) {
      this.pending.delete(threadId)
      throw e
    }
  }

  /** 只取已建实例（内存缓存命中才返回）。未跑过 query 的 thread → undefined。 */
  get(threadId: string): FileHistoryService | undefined {
    return this.services.get(threadId)
  }

  /**
   * 回退入口（IPC / action-bridge）专用：取已建实例；**内存 miss 时从磁盘 manifest
   * lazy 恢复**。这是修 Bug 1（进程重启后对一个没再发过消息的历史会话点回退失败）的
   * 核心——重启后内存 registry 空，`get` 返回 undefined 会拒绝回退，但磁盘
   * `<historyRoot>/<sha256(threadId)>/manifest.json` + 备份仍在，据此恢复出可 rewind 的 service。
   *
   * 步骤：
   *   1. 先等本 thread 的 in-flight 移除落定（tombstone），与 `getOrCreate` 同序——避免
   *      读到将被删的缓存、或与旧 service 的 flush 抢同一 manifest（P1-3 语义复用）。
   *   2. 命中内存缓存 → 直接返回（此分支**不读磁盘**：覆盖"刚 track 完、debounce flush
   *      尚未落盘"窗口——此刻 manifest 可能还没 workspaceRoot，但内存账本已可回退）。
   *   3. 内存无 → 只读探测 manifest 的 canonical workspaceRoot；存在则
   *      `getOrCreate(threadId, root)`（`init` 按 manifest 加载 snapshots，root 一致不 seal）。
   *   4. manifest 不存在 / 无 workspaceRoot（从未 track / 旧格式）→ 返回 undefined
   *      （调用方据此拒绝回退，绝不静默成功 / 绝不整仓 reset）。
   *
   * 与 `getOrCreate` 共用同一 services / pending / removing Map：并发去重、tombstone、
   * root 漂移语义全部复用，不引入重复实例 / 竞态。
   */
  async getOrResume(threadId: string): Promise<FileHistoryService | undefined> {
    // P1-3：等本 thread 的移除先完成（若有），再判定缓存状态（与 getOrCreate 同序）。
    const removal = this.removing.get(threadId)
    if (removal) await removal

    const existing = this.services.get(threadId)
    if (existing) return existing

    // 内存无 → 按 threadId 从磁盘探测账本（manifest 记录的 canonical workspaceRoot）。
    const workspaceRoot = await peekFileHistoryWorkspaceRoot(this.opts.historyRoot, threadId)
    if (!workspaceRoot) return undefined
    return this.getOrCreate(threadId, workspaceRoot)
  }

  /**
   * 从内存缓存移除（session 销毁时调，防内存泄漏）。**不删磁盘备份 / manifest**——
   * 留给后续 resume：下次同 threadId `getOrCreate` 会 `init` 从 manifest 重新加载。
   *
   * P1-3：**先 await flush（内含 clearTimeout）再删 Map**，且全程置 removing tombstone——
   * getOrCreate 命中 tombstone 会先等本次移除落定，杜绝"旧 flush 与新 service 重建
   * 抢同一 manifest"。重入同 thread 的 remove 复用同一 in-flight promise。
   */
  async remove(threadId: string): Promise<void> {
    const inflight = this.removing.get(threadId)
    if (inflight) return inflight
    const svc = this.services.get(threadId)
    if (!svc) return
    const p = (async () => {
      try {
        await svc.flush().catch(() => {})
      } finally {
        this.services.delete(threadId)
        this.removing.delete(threadId)
      }
    })()
    this.removing.set(threadId, p)
    return p
  }

  /**
   * 清空所有缓存（host 停止时调）。**先 flush 各 service 再清 Map**（与 remove 同序，
   * flush 期间缓存仍在，避免并发 getOrCreate 重建抢 manifest），**不删磁盘**——
   * 下次 getOrCreate 仍可从 manifest resume。flush 降级 / 抛错经日志可观测（P2-5③）。
   */
  async clear(): Promise<void> {
    const entries = [...this.services.values()]
    const results = await Promise.allSettled(entries.map((svc) => svc.flushNow()))
    this.services.clear()
    for (const r of results) {
      if (r.status === 'fulfilled' && !r.value.ok) {
        this.opts.logger.warn(`[FileHistoryRegistry] clear: a service flush failed/degraded: ${r.value.error}`)
      } else if (r.status === 'rejected') {
        this.opts.logger.warn(`[FileHistoryRegistry] clear: a service flush threw: ${String(r.reason)}`)
      }
    }
  }

  /** 当前缓存的 thread 数（诊断 / 测试用）。 */
  size(): number {
    return this.services.size
  }
}
