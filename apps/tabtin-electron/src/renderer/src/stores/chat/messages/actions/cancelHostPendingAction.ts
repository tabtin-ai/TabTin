/**
 * Host 排队项「移除 / 撤回编辑」
 *
 * 调 `agent-engine:cancel-queued-run` 丢掉 Host 单条排队，再清 renderer 镜像。
 * 编辑路径额外把正文回填 Composer（ 同款 prefill）。
 */

import type { ChatAttachment } from '@/components/chat/types'
import { createLogger } from '@/utils/logger'
import { trackChatTelemetry } from '../../execution/chatTelemetry'
import { useChatRuntimeStore } from '../../../useChatRuntimeStore'
import type { HostPendingSendItem } from '../hostPending/hostPendingSendSlice'

const log = createLogger('Chat')

interface CancelHostPendingRoot {
  hostPendingSendsBySessionId: Record<string, HostPendingSendItem[] | undefined>
  removeHostPendingSend: (sessionId: string, runId: string) => void
}

export interface CancelHostPendingStore {
  cancelHostPendingSend: (sessionId: string, runId: string) => Promise<boolean>
  editHostPendingSend: (sessionId: string, runId: string) => Promise<boolean>
}

export function createCancelHostPendingActions(
  get: () => CancelHostPendingRoot,
): CancelHostPendingStore {
  const cancelOnHost = async (sessionId: string, runId: string): Promise<boolean> => {
    if (!sessionId || !runId) return false

    const cancelQueuedRun = window.tabtin?.agentEngine?.cancelQueuedRun
    if (typeof cancelQueuedRun !== 'function') {
      log.warn('[cancelQueuedRun] bridge unavailable')
      trackChatTelemetry('queue.cancel_queued.no_bridge', { runId }, {
        counterKey: 'queue.cancel_queued.no_bridge',
        sessionId,
      })
      // 无 bridge 时仍清镜像，避免 UI 卡住；Host 侧若仍排队会靠 run_sync 再投影
      get().removeHostPendingSend(sessionId, runId)
      return true
    }

    try {
      const res = await cancelQueuedRun({ sessionId, runId })
      if (!res?.cancelled) {
        log.warn('[cancelQueuedRun] host rejected', {
          sessionId: sessionId.slice(0, 8),
          runId: runId.slice(0, 8),
          error: res?.error,
        })
        trackChatTelemetry('queue.cancel_queued.rejected', {
          runId,
          error: res?.error ?? 'not_cancelled',
        }, {
          counterKey: 'queue.cancel_queued.rejected',
          sessionId,
        })
        // Host 已无该项时仍清镜像（对账）
        get().removeHostPendingSend(sessionId, runId)
        return false
      }

      get().removeHostPendingSend(sessionId, runId)
      trackChatTelemetry('queue.cancel_queued.ok', {
        runId,
        queued: res.queuedRunIds?.length ?? 0,
      }, {
        counterKey: 'queue.cancel_queued.ok',
        sessionId,
      })
      return true
    } catch (err) {
      log.warn('[cancelQueuedRun] IPC failed', err)
      trackChatTelemetry('queue.cancel_queued.error', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      }, {
        counterKey: 'queue.cancel_queued.error',
        sessionId,
      })
      return false
    }
  }

  return {
    cancelHostPendingSend: (sessionId, runId) => cancelOnHost(sessionId, runId),

    editHostPendingSend: async (sessionId, runId) => {
      const item = get().hostPendingSendsBySessionId[sessionId]?.find((p) => p.runId === runId)
      if (!item) return false

      const message = item.userMessage.content?.trim()
        || item.titleText.trim()
        || ''
      const rawAttachments = (item.userMessage as { attachments?: ChatAttachment[] }).attachments
      const attachments = Array.isArray(rawAttachments) && rawAttachments.length > 0
        ? rawAttachments.map((a) => ({
            id: a.id,
            filename: a.filename,
            mimeType: a.mimeType,
            size: a.size,
            type: a.type,
            fileId: a.fileId,
            remoteUrl: a.remoteUrl,
            previewUrl: a.previewUrl,
          }))
        : undefined
      const contextBlocks = Array.isArray(
        (item.userMessage as { context_blocks?: Array<Record<string, unknown>> }).context_blocks,
      )
        ? (item.userMessage as { context_blocks?: Array<Record<string, unknown>> }).context_blocks
        : undefined

      await cancelOnHost(sessionId, runId)
      // IPC 硬失败时镜像仍在——不回填，避免 Host 稍后仍发出已编辑内容
      if (get().hostPendingSendsBySessionId[sessionId]?.some((p) => p.runId === runId)) {
        return false
      }

      const prefill = (attachments || contextBlocks)
        ? { message, attachments, contextBlocks }
        : message
      useChatRuntimeStore.getState().setPrefillForSession(sessionId, prefill)
      trackChatTelemetry('queue.edit_queued.ok', { runId }, {
        counterKey: 'queue.edit_queued.ok',
        sessionId,
      })
      return true
    },
  }
}
