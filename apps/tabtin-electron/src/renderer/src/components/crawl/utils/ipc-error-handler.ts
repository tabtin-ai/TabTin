/**
 * 统一 IPC 错误处理
 *
 * 将下载/浏览器模块中分散的 .catch(console.warn) 收敛到此处，
 * 区分可忽略（仅日志）和需用户感知（toast）两类。
 */

import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'

type ErrorSeverity = 'silent' | 'toast'

interface IPCErrorOptions {
  /** 来源模块标识 */
  source: string
  /** 出错操作标识（仅用于日志，不作为用户可见文案） */
  action: string
  /** 是否向用户展示 */
  severity?: ErrorSeverity
  /**
   * toast 标题的 i18n key（如 `crawl:downloads.openFileFailed`）。
   * 缺省时用通用「操作失败」——绝不再把内部 action 标识当标题展示给用户。
   */
  titleKey?: string
}

export function handleIPCError(error: unknown, opts: IPCErrorOptions): void {
  const { source, action, severity = 'silent', titleKey } = opts
  const message = error instanceof Error ? error.message : String(error)

  console.warn(`[${source}] ${action} failed:`, message)

  if (severity === 'toast') {
    toast({
      title: titleKey
        ? i18n.t(titleKey)
        : i18n.t('crawl:downloads.actionFailed', { defaultValue: '操作失败' }),
      // 把真实失败原因（如「文件已被移动或删除」）透出给用户，而不是吞进 console
      description: message || undefined,
      variant: 'destructive',
    })
  }
}

/**
 * 创建绑定到特定来源模块的错误处理器，减少重复参数。
 */
export function createIPCErrorHandler(source: string) {
  return (action: string, severity?: ErrorSeverity, titleKey?: string) =>
    (error: unknown) => handleIPCError(error, { source, action, severity, titleKey })
}
