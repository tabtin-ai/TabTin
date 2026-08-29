/**
 * SessionPauseController — cooperative pause gate shared by Electron / Daemon.
 *
 * Pause takes effect at the next safe engine boundary (before an iteration /
 * before a tool batch). The in-flight LLM/tool step is allowed to finish;
 * cancel remains the immediate abort path. Resume releases every waiter for
 * this session **unless** an Access Barrier HITL park is still held.
 *
 * HITL park（Access Barrier 等能力层挂起）与用户手动 pause 正交：
 * - `acquireHitlPark` / `releaseHitlPark`：引用计数；发卡时 +1，决议/超时/取消 -1
 * - 手动 `pause` / `resume`：不碰 HITL 计数
 * - `waitIfPaused`：任一为真都挡主循环（避免 shell 后台化后「有卡但模型继续跑」）
 */
export class SessionPauseController {
  private paused = false
  /** Access Barrier 等能力层 HITL 占用数；>0 时主循环与用户 pause 一样等待。 */
  private hitlParkCount = 0
  private waiters = new Set<() => void>()

  get isPaused(): boolean {
    return this.paused
  }

  get isHitlParked(): boolean {
    return this.hitlParkCount > 0
  }

  /** 当前是否应挡住下一轮模型 / 工具批次。 */
  get shouldBlock(): boolean {
    return this.paused || this.hitlParkCount > 0
  }

  pause(): boolean {
    if (this.paused) return false
    this.paused = true
    return true
  }

  resume(): boolean {
    if (!this.paused) return false
    this.paused = false
    this.releaseWaitersIfClear()
    return true
  }

  /**
   * 能力层 HITL 开始等人（如 Access Barrier 卡片）。可重入：同会话多卡用引用计数。
   * @returns 本次 acquire 后的占用数
   */
  acquireHitlPark(): number {
    this.hitlParkCount += 1
    return this.hitlParkCount
  }

  /**
   * 能力层 HITL 结束（用户决议 / 超时 / abort cancel）。计数到 0 且未手动 pause 时放行。
   * @returns 本次 release 后的占用数
   */
  releaseHitlPark(): number {
    if (this.hitlParkCount <= 0) return 0
    this.hitlParkCount -= 1
    this.releaseWaitersIfClear()
    return this.hitlParkCount
  }

  async waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.shouldBlock || signal?.aborted) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        signal?.removeEventListener('abort', release)
        this.waiters.delete(release)
        resolve()
      }
      this.waiters.add(release)
      signal?.addEventListener('abort', release, { once: true })
      if (!this.shouldBlock) release()
    })
  }

  private releaseWaitersIfClear(): void {
    if (this.shouldBlock) return
    for (const release of this.waiters) release()
    this.waiters.clear()
  }
}
