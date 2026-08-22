import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from '@tabtin/smartsheet-ui/toast'
import {
  requestDeniedResourceAccess,
  type ResourceAccessRequestRole,
  type ResourceAccessResourceType,
} from '@/services/tabchatApi'
import { createLogger } from '@/utils/logger'

const log = createLogger('PermissionDeniedAccessRequest')

interface UsePermissionDeniedAccessRequestOptions {
  resourceType: ResourceAccessResourceType
  resourceId: string
}

export function usePermissionDeniedAccessRequest({
  resourceType,
  resourceId,
}: UsePermissionDeniedAccessRequestOptions) {
  const { t } = useTranslation('common')
  const [requestingRole, setRequestingRole] = useState<ResourceAccessRequestRole | null>(null)
  const [requestedRole, setRequestedRole] = useState<ResourceAccessRequestRole | null>(null)

  useEffect(() => {
    setRequestingRole(null)
    setRequestedRole(null)
  }, [resourceId, resourceType])

  const requestAccess = useCallback(async (role: ResourceAccessRequestRole) => {
    if (!resourceId || requestingRole) return
    setRequestingRole(role)
    try {
      const submitted = await requestDeniedResourceAccess(resourceType, resourceId, role)
      const effectiveRole = submitted.role === 'editor' ? 'editor' : 'viewer'
      setRequestedRole(effectiveRole)
      toast({
        title: t('share.editor.removed.requestSubmitted', {
          defaultValue: role === 'editor' ? '已提交编辑申请' : '已提交查看申请',
        }),
        description: t('share.editor.removed.requestSubmittedDesc', {
          defaultValue: '已通知资源所有者，通过后即可重新打开',
        }),
      })
    } catch (error) {
      log.warn('permission denied access request failed', {
        resourceType,
        resourceId,
        role,
        error,
      })
      toast({
        title: t('share.editor.removed.requestFailed', { defaultValue: '申请失败' }),
        description: error instanceof Error
          ? error.message
          : t('share.editor.removed.requestFailedDesc', { defaultValue: '请稍后重试' }),
        variant: 'destructive',
      })
    } finally {
      setRequestingRole(null)
    }
  }, [requestingRole, resourceId, resourceType, t])

  const requestViewAccess = useCallback(() => requestAccess('viewer'), [requestAccess])
  const requestEditAccess = useCallback(() => requestAccess('editor'), [requestAccess])

  return {
    requestingRole,
    requestedRole,
    requestViewAccess,
    requestEditAccess,
  }
}
