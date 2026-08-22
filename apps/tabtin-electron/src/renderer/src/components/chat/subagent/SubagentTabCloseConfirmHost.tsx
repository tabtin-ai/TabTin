/**
 * SubagentTabCloseConfirmHost — 子 Agent tab 关闭确认对话框宿主。
 *
 * 挂在 App 根级；由 handler.beforeClose 通过 `requestSubagentTabCloseConfirm`
 * 唤起。文案明示"关闭标签不会停止该子 Agent"——避免用户误以为"× 即停止"。
 */

import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tabtin/smartsheet-ui'
import {
  settleSubagentTabCloseConfirm,
  useSubagentTabCloseConfirmStore,
} from './subagentTabCloseConfirm'

export function SubagentTabCloseConfirmHost(): React.ReactElement {
  const { t } = useTranslation('chat')
  const open = useSubagentTabCloseConfirmStore((s) => s.open)
  const rawName = useSubagentTabCloseConfirmStore((s) => s.displayName)
  const pendingCount = useSubagentTabCloseConfirmStore((s) => s.pendingCount)
  const displayName = rawName || t('subagent.tab.fallbackTitle', { defaultValue: '子 Agent' })

  const remainingAfterCurrent = Math.max(0, pendingCount - 1)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settleSubagentTabCloseConfirm('keep')
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-subtitle font-semibold">
            {t('subagent.tab.closeRunningConfirm.title', { defaultValue: '关闭子 Agent 标签' })}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 pt-1">
              <p className="m-0 text-body text-muted-foreground/80">
                {t('subagent.tab.closeRunningConfirm.detail', {
                  name: displayName,
                  defaultValue:
                    '关闭标签不会停止「{{name}}」的执行。如需停止，请先点取消按钮。',
                })}
              </p>
              {remainingAfterCurrent > 0 ? (
                <p className="m-0 text-body text-muted-foreground/60">
                  {t('tabdoc:closeConfirm.queueHint', {
                    count: remainingAfterCurrent,
                    defaultValue: '还有 {{count}} 个标签待确认',
                  })}
                </p>
              ) : null}
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:space-x-2">
          <Button
            type="button"
            variant="outline"
            className="w-full text-body sm:w-auto"
            onClick={() => settleSubagentTabCloseConfirm('keep')}
            autoFocus
          >
            {t('subagent.tab.closeRunningConfirm.cancel', { defaultValue: '保留标签' })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full text-body sm:w-auto"
            onClick={() => settleSubagentTabCloseConfirm('close')}
          >
            {t('subagent.tab.closeRunningConfirm.confirm', { defaultValue: '仅关闭标签' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
