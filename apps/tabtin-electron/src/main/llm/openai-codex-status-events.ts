import { getMainWindow } from '../window-manager.js'
import { createLogger } from '../logger.js'

const log = createLogger('OpenAICodexStatus')

export const OPENAI_CODEX_STATUS_CHANGED_CHANNEL =
  'openai-codex:status-changed'

export type OpenAICodexConnectionStatus = 'connected' | 'disconnected'

const mainStatusListeners = new Set<(
  status: OpenAICodexConnectionStatus,
) => void | Promise<void>>()

export function onOpenAICodexStatusChanged(
  listener: (
    status: OpenAICodexConnectionStatus,
  ) => void | Promise<void>,
): () => void {
  mainStatusListeners.add(listener)
  return () => { mainStatusListeners.delete(listener) }
}

/**
 * 先等主进程订阅方完成失效清理，再通知 renderer 重载目录。
 * 这样登出/授权失效不会出现「UI 先刷新到旧默认，磁盘稍后才清」的竞态。
 */
export async function notifyOpenAICodexStatusChanged(
  status: OpenAICodexConnectionStatus,
): Promise<void> {
  const results = await Promise.allSettled(
    [...mainStatusListeners].map(async (listener) => listener(status)),
  )
  for (const result of results) {
    if (result.status === 'rejected') {
      log.warn(
        'Main-process status cleanup failed:',
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      )
    }
  }
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(OPENAI_CODEX_STATUS_CHANGED_CHANNEL, { status })
}
