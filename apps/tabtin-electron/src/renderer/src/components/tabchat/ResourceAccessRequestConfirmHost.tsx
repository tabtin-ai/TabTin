import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@components/ui'
import { useResourceAccessRequestStore } from '@stores/useResourceAccessRequestStore'

/**
 * App 根级宿主：owner 点击 resource_access_request 通知后弹出确认框。
 * 取消只关弹窗（申请仍 pending）；确认调 approve API。
 */
export const ResourceAccessRequestConfirmHost: React.FC = () => {
  const { t } = useTranslation(['common', 'tabchat'])
  const open = useResourceAccessRequestStore((state) => state.open)
  const title = useResourceAccessRequestStore((state) => state.title)
  const body = useResourceAccessRequestStore((state) => state.body)
  const isApproving = useResourceAccessRequestStore((state) => state.isApproving)
  const close = useResourceAccessRequestStore((state) => state.close)
  const approve = useResourceAccessRequestStore((state) => state.approve)

  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) close()
  }, [close])

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title || t('common:notification.resourceAccess.confirmTitle', {
        defaultValue: '确认授予查看权限？',
      })}
      description={body || t('common:notification.resourceAccess.confirmDescription', {
        defaultValue: '确认后对方将获得该资源的查看（viewer）权限。取消仅关闭弹窗，申请仍保持待处理。',
      })}
      confirmText={t('common:notification.resourceAccess.confirmAction', {
        defaultValue: '确认授权',
      })}
      cancelText={t('common:cancel', { defaultValue: '取消' })}
      onConfirm={approve}
      isLoading={isApproving}
      container={null}
    />
  )
}
