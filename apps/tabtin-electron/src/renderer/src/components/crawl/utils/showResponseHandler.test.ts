import { describe, expect, it, vi } from 'vitest'
import {
  handleCrawlViewShowResponse,
  type CrawlViewShowResponseHandlers,
} from './showResponseHandler'

function makeHandlers(): CrawlViewShowResponseHandlers & {
  calls: { name: string; args: unknown[] }[]
} {
  const calls: { name: string; args: unknown[] }[] = []
  return {
    onSuccess: vi.fn(() => calls.push({ name: 'onSuccess', args: [] })),
    onDeferredOrSkipped: vi.fn((kind, reason) =>
      calls.push({ name: 'onDeferredOrSkipped', args: [kind, reason] }),
    ),
    onPartitionRebuildFailure: vi.fn((detail) =>
      calls.push({ name: 'onPartitionRebuildFailure', args: [detail] }),
    ),
    onOtherFailure: vi.fn((msg) => calls.push({ name: 'onOtherFailure', args: [msg] })),
    calls,
  }
}

describe('handleCrawlViewShowResponse — Wave 3 收尾 L-W3-6', () => {
  it('真正成功（无 rebuilt 字段）→ onSuccess', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse({ success: true }, h)
    expect(h.onSuccess).toHaveBeenCalledTimes(1)
    expect(h.onDeferredOrSkipped).not.toHaveBeenCalled()
    expect(h.onPartitionRebuildFailure).not.toHaveBeenCalled()
    expect(h.onOtherFailure).not.toHaveBeenCalled()
  })

  it('rebuilt: true → onSuccess（与首次 show 语义一致）', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse({ success: true, rebuilt: true }, h)
    expect(h.onSuccess).toHaveBeenCalledTimes(1)
    expect(h.onDeferredOrSkipped).not.toHaveBeenCalled()
  })

  it('deferred: run-in-progress → onDeferredOrSkipped, 不调 onSuccess', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse(
      { success: true, rebuilt: false, deferred: 'run-in-progress' },
      h,
    )
    expect(h.onSuccess).not.toHaveBeenCalled()
    expect(h.onDeferredOrSkipped).toHaveBeenCalledWith('deferred', 'run-in-progress')
    expect(h.onPartitionRebuildFailure).not.toHaveBeenCalled()
  })

  it('skipped: rebuild-in-flight → onDeferredOrSkipped, 不调 onSuccess', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse(
      { success: true, rebuilt: false, skipped: 'rebuild-in-flight' },
      h,
    )
    expect(h.onSuccess).not.toHaveBeenCalled()
    expect(h.onDeferredOrSkipped).toHaveBeenCalledWith('skipped', 'rebuild-in-flight')
  })

  it('failure 含 "partition rebuild" → onPartitionRebuildFailure, 抽 detail', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse(
      {
        success: false,
        error: 'partition rebuild succeeded destroy but failed show: view init failed',
      },
      h,
    )
    expect(h.onPartitionRebuildFailure).toHaveBeenCalledWith('view init failed')
    expect(h.onSuccess).not.toHaveBeenCalled()
    expect(h.onOtherFailure).not.toHaveBeenCalled()
  })

  it('failure 不含 "partition rebuild" → onOtherFailure', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse(
      { success: false, error: 'workspace view requires crawlspaceId/kind/partition' },
      h,
    )
    expect(h.onOtherFailure).toHaveBeenCalledWith(
      'workspace view requires crawlspaceId/kind/partition',
    )
    expect(h.onPartitionRebuildFailure).not.toHaveBeenCalled()
  })

  it('failure 无 error 字段 → onOtherFailure 用兜底字符串', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse({ success: false }, h)
    expect(h.onOtherFailure).toHaveBeenCalledWith('show returned success:false')
  })

  it('response 为 undefined → 不调任何 handler', () => {
    const h = makeHandlers()
    handleCrawlViewShowResponse(undefined, h)
    expect(h.calls).toEqual([])
  })

  it('success: true + 同时带 deferred + skipped → 优先按 deferred 处理', () => {
    // 主进程当前不会同时返回，但防御性测试确保优先级清晰：deferred 比 skipped
    // 更"硬"（用户能看到的 active run 在跑），不应被 skipped 路径覆盖。
    const h = makeHandlers()
    handleCrawlViewShowResponse(
      { success: true, deferred: 'run-in-progress', skipped: 'rebuild-in-flight' },
      h,
    )
    expect(h.onDeferredOrSkipped).toHaveBeenCalledWith('deferred', 'run-in-progress')
    expect(h.onDeferredOrSkipped).toHaveBeenCalledTimes(1)
    expect(h.onSuccess).not.toHaveBeenCalled()
  })
})
