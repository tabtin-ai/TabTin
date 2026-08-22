/**
 * pending-guests — announce ↔ attach ↔ bind 配对注册表
 *
 * flag=webview 时"创建 guest"由 renderer 的 <webview> 元素触发，主进程无法在
 * 创建点注入配置，所以采用三段协议：
 *
 *   1. **announce**（renderer 创建元素前）：`webview-host:announce(tabId, config)`
 *      主进程校验并归一化配置（partition 经 SessionConfigFactory），登记 pending。
 *   2. **did-attach**（guest 进程挂载）：按 session 身份尝试配对 pending——
 *      **唯一候选才配对**；0 个（如 Tin guest）或多个（同 partition 多 tab
 *      并发）都不配，等 bind 兜底。防串号：宁可不配，不猜。
 *   3. **bind**（renderer dom-ready 后）：`webview-host:bind(tabId, webContentsId)`
 *      权威绑定。校验 wc 存在、类型为 webview、宿主是发送者、session 与
 *      announce 声明一致，配对成功后触发能力装配。
 *
 * 竞态口径：
 *   - attach 先于 announce：did-attach 找不到候选 → 挂到 unclaimed，announce
 *     到达后不回扫（bind 会兜底完成配对）。
 *   - 同 tabId 重复 announce：视为 renderer 重建元素（旧 guest 已死/未 attach），
 *     覆盖 pending 并 log.warn。
 *   - 同 tabId 重复 attach/bind：已绑定且旧 guest 存活 → 拒绝新绑定；
 *     旧 guest 已销毁 → 允许换绑（crash 后 renderer 重建元素场景）。
 *
 * 本模块不 import electron（session 身份用 unknown 引用比对），可直接单测。
 */

export interface AnnouncedGuestConfig {
  tabId: string
  /** 归一化后的完整 partition 字符串（'' = 默认 session） */
  effectivePartition: string
  /** 期望的 session 身份引用（session.fromPartition(...) / defaultSession） */
  expectedSession: unknown
  /** 初始 URL */
  url: string
  /** mergeProfileConfig 产出的最终配置（webview-host 装配时透传给 ViewFactory） */
  finalConfig: unknown
  /**
   * ：受限放行 `file://` 的预览根（announce 时从影子 WCV view config
   * 恢复的 Space 工作目录）。空/缺省表示本 guest 非本地 HTML 预览，不放行 file://。
   */
  localPreviewRoot?: string
  announcedAt: number
}

export interface BoundGuest {
  tabId: string
  webContentsId: number
  session: unknown
}

export class PendingGuestRegistry {
  private pending = new Map<string, AnnouncedGuestConfig>()
  /** tabId → 已绑定 guest */
  private bound = new Map<string, BoundGuest>()
  /** webContentsId → tabId 反查 */
  private wcIdToTabId = new Map<number, string>()

  announce(config: AnnouncedGuestConfig, log: (msg: string) => void): void {
    if (this.pending.has(config.tabId)) {
      log(`重复 announce，覆盖旧 pending: ${config.tabId}`)
    }
    this.pending.set(config.tabId, config)
  }

  getPending(tabId: string): AnnouncedGuestConfig | undefined {
    return this.pending.get(tabId)
  }

  /**
   * ：当前所有 pending announce 声明的预览根去重集合。
   * will-attach 时元素刚插入、guest 尚未配对（pending 未取走），据此判定
   * `file://` src 是否落在某个受信预览根内。
   */
  getAllPendingLocalPreviewRoots(): string[] {
    const roots = new Set<string>()
    for (const entry of this.pending.values()) {
      if (entry.localPreviewRoot) roots.add(entry.localPreviewRoot)
    }
    return Array.from(roots)
  }

  /**
   * did-attach 配对：按 session 身份找 pending 候选。
   * 唯一候选 → 取出并返回；0 或多个 → 返回 null（等 bind 兜底）。
   */
  takeSolePendingBySession(session: unknown): AnnouncedGuestConfig | null {
    const candidates: AnnouncedGuestConfig[] = []
    for (const entry of this.pending.values()) {
      if (entry.expectedSession === session) {
        candidates.push(entry)
      }
    }
    if (candidates.length !== 1) return null
    const sole = candidates[0]
    this.pending.delete(sole.tabId)
    return sole
  }

  /**
   * bind 配对：按 tabId 取出 pending（session 必须与 announce 一致，
   * 由调用方先校验后再调用本方法）。
   */
  takePendingByTabId(tabId: string): AnnouncedGuestConfig | null {
    const entry = this.pending.get(tabId)
    if (!entry) return null
    this.pending.delete(tabId)
    return entry
  }

  /**
   * 登记绑定。已有绑定且未被 releaseBinding 清理 → 拒绝（防串号 / 防重复 attach）。
   */
  registerBinding(guest: BoundGuest): { ok: true } | { ok: false; reason: string } {
    const existing = this.bound.get(guest.tabId)
    if (existing) {
      return {
        ok: false,
        reason: `tabId 已绑定到 webContents ${existing.webContentsId}（新请求 ${guest.webContentsId}）`,
      }
    }
    const claimedTab = this.wcIdToTabId.get(guest.webContentsId)
    if (claimedTab && claimedTab !== guest.tabId) {
      return {
        ok: false,
        reason: `webContents ${guest.webContentsId} 已绑定到 tab ${claimedTab}`,
      }
    }
    this.bound.set(guest.tabId, guest)
    this.wcIdToTabId.set(guest.webContentsId, guest.tabId)
    return { ok: true }
  }

  getBinding(tabId: string): BoundGuest | undefined {
    return this.bound.get(tabId)
  }

  getTabIdByWebContentsId(webContentsId: number): string | undefined {
    return this.wcIdToTabId.get(webContentsId)
  }

  /** guest 销毁 / 装配失败时释放绑定，允许后续换绑 */
  releaseBinding(tabId: string): void {
    const existing = this.bound.get(tabId)
    if (existing) {
      this.wcIdToTabId.delete(existing.webContentsId)
      this.bound.delete(tabId)
    }
  }

  /** renderer 放弃创建（destroy 早于 attach）时清理 pending */
  discardPending(tabId: string): void {
    this.pending.delete(tabId)
  }

  clearForTesting(): void {
    this.pending.clear()
    this.bound.clear()
    this.wcIdToTabId.clear()
  }
}
