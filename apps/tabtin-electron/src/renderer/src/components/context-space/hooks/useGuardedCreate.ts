/**
 * guardApp — 通用的「创建资源」守卫
 *
 * 封装了创建流程中的公共关切：App 启用检查 + toast 提示。
 * 返回 true 表示可以继续执行，false 表示已被拦截。
 */
import { toast } from '@tabtin/smartsheet-ui'
import type { TFunction } from 'i18next'

export function guardApp(
  appId: string,
  appName: string,
  isAppEnabled: (appId?: string) => boolean,
  t: TFunction,
): boolean {
  if (!isAppEnabled(appId)) {
    toast({
      title: t('apps.disabledActionTitle'),
      description: t('apps.disabledActionDescription', { appName }),
    })
    return false
  }
  return true
}

/**
 * 通用的受保护资源创建执行器。
 * 封装防重入 + App 启用检查 + try/catch/finally 样板。
 *
 * - `create` 返回 null/undefined 视为静默中断（不触发 onSuccess/onError）
 * - 未提供 `onError` 时使用默认的 console.error + toast
 */
export async function executeGuardedCreate<T>(opts: {
  creatingRef: { current: boolean }
  /** 驱动按钮 disabled / spinner；与 creatingRef 同步，供 UI 订阅 */
  setBusy?: (busy: boolean) => void
  appId: string
  appLabel: string
  isAppEnabled: (appId?: string) => boolean
  t: TFunction
  create: () => Promise<T | null | undefined>
  onSuccess: (result: T) => void
  onError?: (error: unknown) => void
}): Promise<void> {
  if (opts.creatingRef.current) return
  if (!guardApp(opts.appId, opts.appLabel, opts.isAppEnabled, opts.t)) return
  opts.creatingRef.current = true
  opts.setBusy?.(true)
  try {
    const result = await opts.create()
    if (result != null) {
      opts.onSuccess(result)
    }
  } catch (error) {
    if (opts.onError) {
      opts.onError(error)
    } else {
      console.error(`[useCreateHandlers] create ${opts.appId} failed:`, error)
      toast({
        title: opts.t('apps.createFailed', { appName: opts.appLabel }),
        description: error instanceof Error ? error.message : undefined,
        variant: 'destructive',
      })
    }
  } finally {
    opts.creatingRef.current = false
    opts.setBusy?.(false)
  }
}
