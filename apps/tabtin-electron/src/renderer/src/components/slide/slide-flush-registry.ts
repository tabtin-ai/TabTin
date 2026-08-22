/**
 * 全局 Slide 编辑器 flush 注册表
 *
 * 解决多 keepAlive tab 场景下 flush-before-close 竞争：
 * 只注册一个 IPC 监听器，收集所有活跃编辑器的保存 Promise，
 * 全部 settle 后才发送一次 flushComplete。
 */

type FlushHandler = () => Promise<void>

const registry = new Map<string, FlushHandler>()
let ipcCleanup: (() => void) | null = null

const FLUSH_TIMEOUT_MS = 3000

function ensureIpcListener(): void {
  if (ipcCleanup) return

  ipcCleanup = window.tabtin?.slide?.onFlushBeforeClose?.(() => {
    const handlers = Array.from(registry.values())
    if (handlers.length === 0) {
      window.tabtin?.slide?.flushComplete?.()
      return
    }

    const promises = handlers.map((h) => {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS))
      return Promise.race([h().catch(() => {}), timeout])
    })

    void Promise.allSettled(promises).then(() => {
      window.tabtin?.slide?.flushComplete?.()
    })
  }) ?? null
}

export function registerFlushHandler(editorId: string, handler: FlushHandler): () => void {
  registry.set(editorId, handler)
  ensureIpcListener()

  return () => {
    registry.delete(editorId)
  }
}

/**
 * App 启动时调用一次，让 `slide:flush-before-close` 监听器常驻注册。
 *
 * 为什么需要：main 进程关主窗口时会发 `slide:flush-before-close` 并等 `slide:flush-complete`
 * 回执（生产超时 4000ms）。若仅靠 registerFlushHandler 懒注册，未打开过 slide 编辑器的
 * 会话就没有监听器，main 干等满超时才强制关窗（用户感知"关窗卡约 4 秒"，见 ）。
 * 启动常驻后，无 handler 时立即回 flushComplete，关窗秒关；打开 slide 后行为不变
 * （ensureIpcListener 幂等）。
 */
export function setupSlideFlushListener(): () => void {
  ensureIpcListener()
  return () => {
    ipcCleanup?.()
    ipcCleanup = null
  }
}
