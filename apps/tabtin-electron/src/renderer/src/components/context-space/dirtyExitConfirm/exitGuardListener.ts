/**
 * 退出守卫监听器（W2.5 T9）
 *
 * 注册一个全局 listener 响应 main 进程的 `app:exit-guard:request`：
 * 1. collectAllDirty() 聚合所有未保存改动
 * 2. requestDirtyExitConfirm() 弹合并对话框
 * 3. 把用户选择 + 保存结果回传 main（'continue' / 'cancel'）
 *
 * 在 AppGlobalEffects 启动时调用 setupExitGuardListener() 一次。
 *
 * 失败语义：
 * - collectAllDirty 抛错 → 走原 'continue'（避免 renderer 异常导致用户无法退出）
 * - requestDirtyExitConfirm 抛错 → 同上
 * - saveAll 部分失败 → toast 提示 + 仍 'cancel'（数据安全优先；用户可以手动重试）
 */
import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import { collectAllDirty } from '../dirtyRegistry'
import {
  requestDirtyExitConfirm,
  type DirtyExitReason,
} from './dirtyExitConfirmStore'

interface SetupOptions {
  /** 测试钩子：覆盖 window.tabtin.exitGuard 接口 */
  exitGuardBridge?: typeof window.tabtin.exitGuard
}

let cleanupFn: (() => void) | null = null

export function setupExitGuardListener(options: SetupOptions = {}): () => void {
  // 已注册过则先卸载（dev hot-reload 防 leak；生产场景 AppGlobalEffects 只 mount 一次）
  if (cleanupFn) cleanupFn()

  const bridge = options.exitGuardBridge ?? window.tabtin?.exitGuard
  if (!bridge) {
    // 非 Electron 环境（test / web preview），跳过
    cleanupFn = null
    return () => {}
  }

  const unsubscribe = bridge.onRequest(async ({ reason, requestId }) => {
    // P0-3 修复（产品视角 Review）：异常时默认 'cancel'（保守不退出 = 数据安全优先），
    // 而非原版本 'continue'（异常时静默退出 = 数据丢失风险）。
    // 与"保存失败则取消退出"承诺方向一致；如果用户重试 ⌘Q 仍异常，会再走一遍——
    // 长期卡死场景由 main 进程的 30s 原生 fallback dialog 兜底。
    let choice: 'continue' | 'cancel' = 'cancel'
    try {
      const dirtyResources = collectAllDirty()
      // payload reason 仅 'app-quit' / 'window-close'；映射到对话框 reason
      const dialogReason: DirtyExitReason = reason
      const result = await requestDirtyExitConfirm({
        resources: dirtyResources,
        reason: dialogReason,
      })
      choice = decideChoice(result.choice, result.saveResults, dialogReason)
    } catch (err) {
      console.error('[exitGuardListener] 处理 exit-guard request 失败，保守回 cancel:', err)
      choice = 'cancel'
    } finally {
      try {
        bridge.sendResponse({ requestId, choice })
      } catch (err) {
        console.error('[exitGuardListener] 回传响应失败:', err)
      }
    }
  })

  cleanupFn = () => {
    try {
      unsubscribe()
    } catch {
      // ignore
    }
    cleanupFn = null
  }
  return cleanupFn
}

/**
 * 由 dialog 选择 + 保存结果决定最终回 main 的 'continue' / 'cancel'。
 *
 * - cancel：用户主动取消 → 直接 cancel
 * - discard：用户放弃改动 → continue
 * - save-all：
 *   - 全成功 → continue
 *   - 全/部分失败 → toast 错误汇总 + cancel（保护用户数据；标签保留供重试）
 *
 * "全部保存失败时回 cancel"是有意为之：让用户感知到"应用没退出，因为有保存失败"，
 * 避免静默退出造成数据丢失认知偏差。
 *
 * 注：reason 参数仅用于日志区分；exit-guard IPC 路径只会传 'app-quit' / 'window-close'，
 * 'space-delete' 走 spaceDeleteGuard 不经此函数（早期分支保留为防御）。
 */
function decideChoice(
  dialogChoice: 'save-all' | 'discard' | 'cancel',
  saveResults: Array<{ resource: { type: string; id: string; title: string }; ok: boolean }> | undefined,
  reason: DirtyExitReason,
): 'continue' | 'cancel' {
  if (dialogChoice === 'cancel') return 'cancel'
  if (dialogChoice === 'discard') return 'continue'

  // dialogChoice === 'save-all'
  const failed = (saveResults ?? []).filter((r) => !r.ok)
  if (failed.length === 0) return 'continue'

  // 全失败 vs 部分失败用不同标题，全失败时"部分文档保存失败"会误导用户
  const total = saveResults?.length ?? 0
  const isAllFailed = failed.length === total && total > 0
  const titleKey = isAllFailed
    ? 'context:dirtyExitConfirm.saveFailedToastTitleAll'
    : 'context:dirtyExitConfirm.saveFailedToastTitle'
  const titleFallback = isAllFailed ? '文档保存全部失败' : '部分文档保存失败'

  toast({
    title: i18n.t(titleKey, { defaultValue: titleFallback }),
    description: i18n.t('context:dirtyExitConfirm.saveFailedToastDesc', {
      defaultValue:
        '{{count}} 个文档未能保存到服务器（已成功保存的已保留）。已取消本次退出，请检查网络后重试，或选择"全部放弃"。',
      count: failed.length,
    }),
    variant: 'destructive',
  })

  // toast 之外再追加一行 fallback 提示日志，便于排障定位
  const fallbackKey = reason === 'space-delete'
    ? 'context:dirtyExitConfirm.saveFailedFallbackKeepSpace'
    : 'context:dirtyExitConfirm.saveFailedFallbackKeepRunning'
  console.info(`[exitGuardListener] ${i18n.t(fallbackKey, { defaultValue: '保存失败 → 已取消退出' })}`)

  return 'cancel'
}

/** 测试用 —— 主动卸载监听器 */
export function _disposeExitGuardListener(): void {
  if (cleanupFn) cleanupFn()
}
