import React, { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast, ToastAction } from '@tabtin/smartsheet-ui/toast'
import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { useInvitationInboxStore } from '@stores/useInvitationInboxStore'
import { InvitationListDialog } from '@/components/invitation/InvitationListDialog'
import { InvitationResponseDialog } from '@/components/invitation/InvitationResponseDialog'

type InvitationReceivedDetail = {
  invitationId?: string
  isSync?: boolean
}

export const InvitationInboxHost: React.FC = () => {
  const { t } = useTranslation('common')
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const userId = useAuthStore(state => state.user?.id ?? null)

  const pending = useInvitationInboxStore(state => state.pending)
  const activeInvitation = useInvitationInboxStore(state => state.activeInvitation)
  const listOpen = useInvitationInboxStore(state => state.listOpen)
  const refreshPending = useInvitationInboxStore(state => state.refreshPending)
  const openByInvitationId = useInvitationInboxStore(state => state.openByInvitationId)
  const selectInvitation = useInvitationInboxStore(state => state.selectInvitation)
  const closeResponse = useInvitationInboxStore(state => state.closeResponse)
  const closeList = useInvitationInboxStore(state => state.closeList)
  const onResponded = useInvitationInboxStore(state => state.onResponded)
  const autoShownRef = useRef(false)

  useEffect(() => {
    autoShownRef.current = false
  }, [userId])

  useEffect(() => {
    if (!activeInvitation) return
    if (pending.length > 0 && !pending.some(item => item.id === activeInvitation.id)) {
      closeResponse()
    }
  }, [activeInvitation, closeResponse, pending])

  useEffect(() => {
    if (!isAuthenticated) {
      autoShownRef.current = false
      useInvitationInboxStore.setState({
        pending: [],
        activeInvitation: null,
        listOpen: false,
        isLoading: false,
      })
      return
    }
    void refreshPending().then((items) => {
      if (items.length === 0 || autoShownRef.current) return
      autoShownRef.current = true
      if (items.length === 1) {
        useInvitationInboxStore.setState({ activeInvitation: items[0], listOpen: false })
        return
      }
      useInvitationInboxStore.setState({ listOpen: true, activeInvitation: null })
    })
  }, [isAuthenticated, refreshPending, userId])

  useEffect(() => {
    if (!isAuthenticated) return

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<InvitationReceivedDetail>).detail
      void refreshPending()

      if (detail?.isSync || !detail?.invitationId) return

      toast({
        title: t('notification.invitation.receivedTitle'),
        description: t('notification.invitation.receivedDescription'),
        action: (
          <ToastAction
            altText={t('notification.invitation.viewInvitation')}
            onClick={() => {
              void openByInvitationId(detail.invitationId!)
            }}
          >
            {t('notification.invitation.viewInvitation')}
          </ToastAction>
        ),
      })
    }

    window.addEventListener('tabtin:invitation-received', handler)
    return () => window.removeEventListener('tabtin:invitation-received', handler)
  }, [isAuthenticated, openByInvitationId, refreshPending, t])

  if (!isAuthenticated) return null

  return (
    <>
      {listOpen && pending.length > 0 && (
        <InvitationListDialog
          invitations={pending}
          onSelect={selectInvitation}
          onClose={closeList}
        />
      )}
      {activeInvitation && (
        <InvitationResponseDialog
          invitation={activeInvitation}
          onClose={closeResponse}
          onResponded={() => {
            void onResponded()
          }}
        />
      )}
    </>
  )
}
