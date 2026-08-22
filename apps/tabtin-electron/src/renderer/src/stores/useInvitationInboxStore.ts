import { create } from 'zustand'
import { toast } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import {
  InvitationApiService,
  type PendingInvitation,
} from '@/services/invitationApi'
import type { NotificationItem } from '@/services/notificationApi'

function readInvitationId(notification: NotificationItem): string | undefined {
  const metadata = notification.metadata as Record<string, unknown> | undefined
  const raw = metadata?.invitation_id ?? metadata?.invitationId
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

interface InvitationInboxState {
  pending: PendingInvitation[]
  isLoading: boolean
  activeInvitation: PendingInvitation | null
  listOpen: boolean
  refreshPending: () => Promise<PendingInvitation[]>
  openFromNotification: (notification: NotificationItem) => Promise<void>
  openByInvitationId: (invitationId: string) => Promise<void>
  openInbox: () => Promise<void>
  selectInvitation: (invitation: PendingInvitation) => void
  closeResponse: () => void
  closeList: () => void
  onResponded: () => Promise<void>
}

export const useInvitationInboxStore = create<InvitationInboxState>((set, get) => ({
  pending: [],
  isLoading: false,
  activeInvitation: null,
  listOpen: false,

  refreshPending: async () => {
    set({ isLoading: true })
    try {
      const pending = await InvitationApiService.listMyPendingInvitations()
      set({ pending, isLoading: false })
      return pending
    } catch {
      set({ isLoading: false })
      return get().pending
    }
  },

  openByInvitationId: async (invitationId) => {
    const pending = await get().refreshPending()
    const target = pending.find(item => item.id === invitationId)
    if (target) {
      set({ activeInvitation: target, listOpen: false })
      return
    }
    if (pending.length === 1) {
      set({ activeInvitation: pending[0], listOpen: false })
      return
    }
    if (pending.length > 1) {
      set({ listOpen: true, activeInvitation: null })
    }
  },

  openFromNotification: async (notification) => {
    const pending = await get().refreshPending()
    const invitationId = readInvitationId(notification)
    if (invitationId) {
      const target = pending.find(item => item.id === invitationId)
      if (target) {
        set({ activeInvitation: target, listOpen: false })
        return
      }
      // ：邀请已接受/拒绝/取消后旧卡仍可能点进来——给明确反馈，勿静默
      toast({
        title: i18n.t('common:notification.invitation.alreadyHandledTitle', {
          defaultValue: '邀请已处理',
        }),
        description: i18n.t('common:notification.invitation.alreadyHandledDescription', {
          defaultValue: '该邀请已接受、拒绝或失效，无需再操作',
        }),
      })
      return
    }
    if (pending.length === 1) {
      set({ activeInvitation: pending[0], listOpen: false })
      return
    }
    if (pending.length > 1) {
      set({ listOpen: true, activeInvitation: null })
    }
  },

  openInbox: async () => {
    const pending = await get().refreshPending()
    if (pending.length === 0) return
    if (pending.length === 1) {
      set({ activeInvitation: pending[0], listOpen: false })
      return
    }
    set({ listOpen: true, activeInvitation: null })
  },

  selectInvitation: (invitation) => {
    set({ activeInvitation: invitation, listOpen: false })
  },

  closeResponse: () => {
    set({ activeInvitation: null })
  },

  closeList: () => {
    set({ listOpen: false })
  },

  onResponded: async () => {
    set({ activeInvitation: null, listOpen: false })
    await get().refreshPending()
  },
}))
