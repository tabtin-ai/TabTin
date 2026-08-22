/** @store-category domain */

/**
 * IM 资源访问申请确认（owner 侧）。
 *
 * 通知点击 → openConfirm → ConfirmDialog；取消只关弹窗（请求仍 pending），
 * 确认走 approve API，授权以服务端为准。
 */
import { create } from 'zustand'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import {
  approveResourceAccessRequest,
  type ResourceAccessResourceType,
} from '@/services/tabchatApi'
import type { NotificationItem } from '@/services/notificationApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('ResourceAccessRequest')

export interface ResourceAccessRequestConfirmPayload {
  requestId: string
  title?: string
  body?: string
  resourceType?: ResourceAccessResourceType | string
  resourceId?: string
}

function readRequestId(notification: NotificationItem): string | undefined {
  const metadata = notification.metadata as Record<string, unknown> | undefined
  const raw = metadata?.request_id ?? metadata?.requestId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function readString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function toConfirmPayload(
  input: ResourceAccessRequestConfirmPayload | NotificationItem,
): ResourceAccessRequestConfirmPayload | null {
  if ('requestId' in input && typeof input.requestId === 'string') {
    const requestId = input.requestId.trim()
    if (!requestId) return null
    return {
      requestId,
      title: input.title,
      body: input.body,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
    }
  }

  const notification = input as NotificationItem
  const requestId = readRequestId(notification)
  if (!requestId) return null
  const metadata = notification.metadata as Record<string, unknown> | undefined
  return {
    requestId,
    title: notification.title,
    body: notification.body,
    resourceType: readString(metadata, 'resource_type') ?? readString(metadata, 'resourceType'),
    resourceId: readString(metadata, 'resource_id') ?? readString(metadata, 'resourceId'),
  }
}

interface ResourceAccessRequestState {
  open: boolean
  requestId: string | null
  title: string
  body: string
  resourceType: string | null
  resourceId: string | null
  isApproving: boolean
  error: string | null
  openConfirm: (input: ResourceAccessRequestConfirmPayload | NotificationItem) => void
  close: () => void
  approve: () => Promise<void>
}

const EMPTY_CONFIRM = {
  open: false,
  requestId: null as string | null,
  title: '',
  body: '',
  resourceType: null as string | null,
  resourceId: null as string | null,
  isApproving: false,
  error: null as string | null,
}

export const useResourceAccessRequestStore = create<ResourceAccessRequestState>((set, get) => ({
  ...EMPTY_CONFIRM,

  openConfirm: (input) => {
    const payload = toConfirmPayload(input)
    if (!payload) {
      toast({
        title: i18n.t('common:notification.resourceAccess.missingRequestTitle', {
          defaultValue: '无法打开申请',
        }),
        description: i18n.t('common:notification.resourceAccess.missingRequestDescription', {
          defaultValue: '通知缺少申请编号，请稍后重试或从消息重新申请',
        }),
        variant: 'destructive',
      })
      return
    }
    const metadataRole = (() => {
      if (!('requestId' in input)) {
        const metadata = (input as NotificationItem).metadata as Record<string, unknown> | undefined
        return readString(metadata, 'role')
      }
      return undefined
    })()
    const isEditor = metadataRole === 'editor'
      || Boolean(payload.body?.includes('编辑'))
      || Boolean(payload.title?.includes('编辑'))
    set({
      open: true,
      requestId: payload.requestId,
      title: payload.title?.trim() || i18n.t(
        isEditor
          ? 'common:notification.resourceAccess.confirmTitleEditor'
          : 'common:notification.resourceAccess.confirmTitle',
        {
          defaultValue: isEditor ? '确认授予编辑权限？' : '确认授予查看权限？',
        },
      ),
      body: payload.body?.trim() || i18n.t(
        isEditor
          ? 'common:notification.resourceAccess.confirmDescriptionEditor'
          : 'common:notification.resourceAccess.confirmDescription',
        {
          defaultValue: isEditor
            ? '确认后对方将获得该资源的编辑（editor）权限。取消仅关闭弹窗，申请仍保持待处理。'
            : '确认后对方将获得该资源的查看（viewer）权限。取消仅关闭弹窗，申请仍保持待处理。',
        },
      ),
      resourceType: payload.resourceType ?? null,
      resourceId: payload.resourceId ?? null,
      isApproving: false,
      error: null,
    })
  },

  close: () => {
    set({ ...EMPTY_CONFIRM })
  },

  approve: async () => {
    const { requestId, isApproving, title, body } = get()
    if (!requestId || isApproving) return
    set({ isApproving: true, error: null })
    try {
      const approved = await approveResourceAccessRequest(requestId)
      const isEditor = approved.role === 'editor'
        || title.includes('编辑')
        || body.includes('编辑')
      toast({
        title: i18n.t(
          isEditor
            ? 'common:notification.resourceAccess.approvedTitleEditor'
            : 'common:notification.resourceAccess.approvedTitle',
          {
            defaultValue: isEditor ? '已授予编辑权限' : '已授予查看权限',
          },
        ),
      })
      set({ ...EMPTY_CONFIRM })
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : i18n.t('common:notification.resourceAccess.approveFailed', {
          defaultValue: '批准失败，请稍后重试',
        })
      log.warn('approve resource access request failed', { requestId, error: err })
      set({ isApproving: false, error: message })
      toast({
        title: i18n.t('common:notification.resourceAccess.approveFailed', {
          defaultValue: '批准失败，请稍后重试',
        }),
        description: message,
        variant: 'destructive',
      })
      throw err
    }
  },
}))
