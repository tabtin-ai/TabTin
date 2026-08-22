import React from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useOrganizationMembershipNoticeStore } from '@/stores/useOrganizationMembershipNoticeStore'

/**
 * 组织成员关系变化的全局弹窗。
 *
 * toast 容易被右上角遮挡或错过；用户被移出当前组织时需要一个明确、跨页面可见的
 * 解释入口，避免误判为普通消息服务断连。
 */
export const OrganizationMembershipNoticeDialogHost: React.FC = () => {
  const { t } = useTranslation('common')
  const notice = useOrganizationMembershipNoticeStore((state) => state.notice)
  const dismissNotice = useOrganizationMembershipNoticeStore((state) => state.dismissNotice)

  return (
    <Dialog open={Boolean(notice)} onOpenChange={(open) => { if (!open) dismissNotice() }}>
      {notice ? (
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{notice.title}</DialogTitle>
            <DialogDescription>{notice.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={dismissNotice}>
              {t('close', '关闭')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
