/**
 * 处理 `crawl-view:show` IPC 返回的响应。
 *
 * 主进程在 partition 不一致 + 有 active run 时返回
 * `{ success: true, deferred: 'run-in-progress', ... }`，在并发重建时返回
 * `{ success: true, skipped: 'rebuild-in-flight' }`。这两种 success 语义
 * 是"未真正重建，只是放过这一次"，**不应**触发 `touchView` /
 * `setDisplayKey` 等"view 真的被使用"副作用——会污染 lastAccessTime / 资源
 * 使用统计，与重建未生效语义矛盾。
 *
 * 真正成功（首次 show / 无须重建 / 重建成功）才走 onSuccess。
 *
 * 失败 + `partition rebuild` 错误码走专用 toast 文案；其他失败走通用错误
 * 上报。
 */
export type CrawlViewShowResponse =
  | {
      success?: boolean
      rebuilt?: boolean
      deferred?: string
      skipped?: string
      error?: string
    }
  | undefined

export interface CrawlViewShowResponseHandlers {
  /** 真正成功（包含 rebuilt 路径） */
  onSuccess: () => void
  /** deferred 或 skipped — 未重建，记日志但不调任何副作用 */
  onDeferredOrSkipped: (kind: 'deferred' | 'skipped', reason: string) => void
  /** partition 重建失败（destroy/show 失败） — 弹专用 toast */
  onPartitionRebuildFailure: (detail: string) => void
  /** 其他失败 — 走通用 reportCrawlViewError */
  onOtherFailure: (errorMsg: string) => void
}

export function handleCrawlViewShowResponse(
  response: CrawlViewShowResponse,
  handlers: CrawlViewShowResponseHandlers,
): void {
  if (!response) return

  if (response.success) {
    if (response.deferred) {
      handlers.onDeferredOrSkipped('deferred', response.deferred)
      return
    }
    if (response.skipped) {
      handlers.onDeferredOrSkipped('skipped', response.skipped)
      return
    }
    handlers.onSuccess()
    return
  }

  if (response.success === false) {
    const errorMsg = response.error || ''
    if (errorMsg.includes('partition rebuild')) {
      const detail = errorMsg.replace(/^partition rebuild[^:]*:\s*/, '')
      handlers.onPartitionRebuildFailure(detail)
      return
    }
    handlers.onOtherFailure(errorMsg || 'show returned success:false')
  }
}
