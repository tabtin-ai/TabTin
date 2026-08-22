import React, { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast, ToastAction } from '@tabtin/smartsheet-ui/toast'

import { useAuthStore, selectIsAuthenticated } from '@stores/useAuthStore'
import { usePendingProjectInvitationStore } from '@stores/usePendingProjectInvitationStore'
import { PROJECTS_UI_ENABLED } from '@/utils/featureFlags'
import { PROJECT_INVITATION_RECEIVED_EVENT } from './PendingProjectInvitations'
import { openCollaborationFromInvite } from './openCollaborationFromInvite'

type ProjectInvitationReceivedDetail = {
  projectId?: string
  organizationId?: string
  isSync?: boolean
}

/**
 * Project 邀请提醒宿主：登录后拉待加入列表；实时收到 space.invitation 时弹 Toast，
 * 并可一键进「协作」（与组织邀请 InvitationInboxHost 同款）。
 */
export const ProjectInvitationReminderHost: React.FC = () => {
  const { t } = useTranslation('common')
  const isAuthenticated = useAuthStore(selectIsAuthenticated)
  const userId = useAuthStore((state) => state.user?.id ?? null)
  const refresh = usePendingProjectInvitationStore((state) => state.refresh)
  const clear = usePendingProjectInvitationStore((state) => state.clear)

  useEffect(() => {
    if (!PROJECTS_UI_ENABLED || !isAuthenticated) {
      clear()
      return
    }
    void refresh()
  }, [clear, isAuthenticated, refresh, userId])

  useEffect(() => {
    if (!PROJECTS_UI_ENABLED || !isAuthenticated) return

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ProjectInvitationReceivedDetail>).detail
      void refresh()

      if (detail?.isSync) return

      toast({
        title: t('notification.projectInvitation.receivedTitle', {
          defaultValue: '收到 Project 邀请',
        }),
        description: t('notification.projectInvitation.receivedDescription', {
          defaultValue: '有人邀请你加入 Project，可在协作中接受',
        }),
        action: (
          <ToastAction
            altText={t('notification.projectInvitation.openCollaboration', {
              defaultValue: '去协作',
            })}
            onClick={() => {
              void openCollaborationFromInvite(detail?.organizationId)
            }}
          >
            {t('notification.projectInvitation.openCollaboration', {
              defaultValue: '去协作',
            })}
          </ToastAction>
        ),
      })
    }

    window.addEventListener(PROJECT_INVITATION_RECEIVED_EVENT, handler)
    return () => window.removeEventListener(PROJECT_INVITATION_RECEIVED_EVENT, handler)
  }, [isAuthenticated, refresh, t])

  return null
}
