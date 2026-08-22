import { create } from 'zustand'
import type { IMMessage } from '@/services/tabchatApi'
import { getMessageAttachmentDownloadUrl } from '@/services/tabchatApi'
import { sanitizeUrl } from '@/lib/sanitizeUrl'
import { MESSAGE_TYPE_FILE, MESSAGE_TYPE_IMAGE } from '@/constants/tabchat'
import { messageStableKey } from '@/services/im/messageMerge'

export type FileAttachmentStatus = 'checking' | 'available' | 'unavailable'

export interface FileAttachmentEntry {
  status: FileAttachmentStatus
  /** 探测时拿到的可用 URL（presigned 或校验过的 access_url）；下载时仍会重新换链以防过期 */
  downloadUrl: string | null
  /** 当前客户端本轮会话中已经完成保存，避免切换对话重挂载后重复下载。 */
  downloadedAt?: number
  /** 本机可直接打开的文件路径：发送方原文件路径，或接收方下载后的保存路径。仅本端内存态。 */
  localPath?: string
}

type ProbeResult = Pick<FileAttachmentEntry, 'status' | 'downloadUrl'>

interface FileAttachmentState {
  statuses: Record<string, FileAttachmentEntry>
  /** 批量确保消息附件可用性已检查（已检查/进行中的会跳过，不重复探测） */
  ensureChecked: (messages: IMMessage[]) => void
  /**
   * 取得可用下载链接；与 ensureChecked / 并发 resolve 共享同一 in-flight 任务，
   * 避免同一附件重复打 /attachment-url。
   */
  resolveDownloadUrl: (message: IMMessage) => Promise<string>
  /** 重新换取短效附件链接；供图片加载时链接已过期的恢复路径使用。 */
  refresh: (message: IMMessage) => Promise<void>
  markUnavailable: (message: IMMessage) => void
  markDownloaded: (message: IMMessage, localPath?: string) => void
  markLocalFile: (message: IMMessage, localPath: string, downloadUrl?: string | null) => void
  reset: () => void
}

/** 探测单条文件消息的可用性（不进 React 渲染路径，避免重复触发） */
async function probeAttachment(message: IMMessage): Promise<ProbeResult> {
  const fileId = message.metadata?.file_id
  const fallbackUrl = sanitizeUrl(message.metadata?.access_url)

  if (fileId) {
    try {
      const data = await getMessageAttachmentDownloadUrl(message.conversation_id, message)
      return { status: 'available', downloadUrl: data.download_url }
    } catch {
      // 有 file_id 的消息以服务端授权换链为准；失败时不要回退旧 access_url，
      // 避免私有/过期 OSS 直链继续在图片和下载路径里被使用。
      return { status: 'unavailable', downloadUrl: null }
    }
  }

  if (fallbackUrl) {
    try {
      const head = await fetch(fallbackUrl, { method: 'HEAD' })
      if (head.ok) return { status: 'available', downloadUrl: fallbackUrl }
    } catch {
      // 兜底探测失败 → 不可用
    }
  }

  return { status: 'unavailable', downloadUrl: null }
}

/** 模块级 in-flight 去重：同一 message 共享探测 Promise */
const _inFlight = new Map<string, Promise<ProbeResult>>()

function isAttachmentMessage(message: IMMessage): boolean {
  return (
    (message.message_type === MESSAGE_TYPE_FILE || message.message_type === MESSAGE_TYPE_IMAGE) &&
    message.id > 0 &&
    !message.is_deleted
  )
}

function applyProbeResult(messageKey: string, result: ProbeResult): void {
  useFileAttachmentStore.setState((state) => {
    const current = state.statuses[messageKey]
    return {
      statuses: {
        ...state.statuses,
        [messageKey]: {
          ...result,
          downloadedAt: current?.downloadedAt,
          localPath: current?.localPath,
        },
      },
    }
  })
}

function startProbe(message: IMMessage): Promise<ProbeResult> {
  const messageKey = messageStableKey(message)
  const existing = _inFlight.get(messageKey)
  if (existing) return existing

  const cached = useFileAttachmentStore.getState().statuses[messageKey]
  if (cached?.status === 'available' || cached?.status === 'unavailable') {
    return Promise.resolve({ status: cached.status, downloadUrl: cached.downloadUrl })
  }

  if (cached?.status !== 'checking') {
    useFileAttachmentStore.setState((state) => ({
      statuses: {
        ...state.statuses,
        [messageKey]: { status: 'checking', downloadUrl: null },
      },
    }))
  }

  const promise = probeAttachment(message)
    .then((result) => {
      applyProbeResult(messageKey, result)
      return result
    })
    .catch(() => {
      const result: ProbeResult = { status: 'unavailable', downloadUrl: null }
      applyProbeResult(messageKey, result)
      return result
    })
    .finally(() => {
      _inFlight.delete(messageKey)
    })

  _inFlight.set(messageKey, promise)
  return promise
}

export const useFileAttachmentStore = create<FileAttachmentState>((set, get) => ({
  statuses: {},

  ensureChecked: (messages) => {
    const { statuses } = get()
    for (const message of messages) {
      if (!isAttachmentMessage(message)) continue
      const messageKey = messageStableKey(message)
      if (statuses[messageKey] || _inFlight.has(messageKey)) continue
      void startProbe(message)
    }
  },

  resolveDownloadUrl: async (message) => {
    if (!isAttachmentMessage(message)) {
      return sanitizeUrl(message.metadata?.access_url)
    }

    const cached = get().statuses[messageStableKey(message)]
    if (cached?.status === 'available') {
      return sanitizeUrl(cached.downloadUrl)
    }
    if (cached?.status === 'unavailable') {
      return ''
    }

    const result = await startProbe(message)
    return result.status === 'available' ? sanitizeUrl(result.downloadUrl) : ''
  },

  refresh: async (message) => {
    const messageKey = messageStableKey(message)
    if (!message.metadata?.file_id || _inFlight.has(messageKey)) return

    const promise = probeAttachment(message)
      .then((result) => {
        applyProbeResult(messageKey, result)
        return result
      })
      .catch(() => {
        const result: ProbeResult = { status: 'unavailable', downloadUrl: null }
        applyProbeResult(messageKey, result)
        return result
      })
      .finally(() => {
        _inFlight.delete(messageKey)
      })

    _inFlight.set(messageKey, promise)
    await promise
  },

  markUnavailable: (message) => {
    const messageKey = messageStableKey(message)
    set((state) => ({
      statuses: { ...state.statuses, [messageKey]: { status: 'unavailable', downloadUrl: null } },
    }))
  },

  markDownloaded: (message, localPath) => {
    const messageKey = messageStableKey(message)
    set((state) => {
      const current = state.statuses[messageKey]
      return {
        statuses: {
          ...state.statuses,
          [messageKey]: {
            status: 'available',
            downloadUrl: current?.downloadUrl ?? null,
            downloadedAt: Date.now(),
            localPath: localPath ?? current?.localPath,
          },
        },
      }
    })
  },

  markLocalFile: (message, localPath, downloadUrl) => {
    const messageKey = messageStableKey(message)
    set((state) => {
      const current = state.statuses[messageKey]
      return {
        statuses: {
          ...state.statuses,
          [messageKey]: {
            status: 'available',
            downloadUrl: downloadUrl ?? current?.downloadUrl ?? null,
            downloadedAt: current?.downloadedAt ?? Date.now(),
            localPath,
          },
        },
      }
    })
  },

  reset: () => {
    _inFlight.clear()
    set({ statuses: {} })
  },
}))
