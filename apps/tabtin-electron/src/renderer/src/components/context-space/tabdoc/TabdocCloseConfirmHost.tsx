import React from 'react'
import { useTranslation } from 'react-i18next'
import { FileText } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
} from '@components/ui'
import { ContextDialogHeader } from '../ContextDialogHeader'
import {
  settleTabDocCloseConfirm,
  useTabDocCloseConfirmStore,
} from './tabdocCloseConfirm'

/**
 * 挂载在 App 根级：TabDoc 关闭未保存改动的标签时由 handler.beforeClose 唤起。
 *
 * 三选交互：取消 / 放弃修改 / 保存并关闭，对齐 VSCode "Save / Don't Save / Cancel" 心智。
 * - ESC 与遮罩点击均 settle 为 'cancel'，遵循"默认不丢数据"原则
 * - DialogFooter 的按钮顺序按 Radix Dialog 推荐：safety → destructive → primary
 */
export function TabdocCloseConfirmHost(): React.ReactElement {
  const { t } = useTranslation('tabdoc')
  const open = useTabDocCloseConfirmStore((s) => s.open)
  const rawName = useTabDocCloseConfirmStore((s) => s.displayName)
  const pendingCount = useTabDocCloseConfirmStore((s) => s.pendingCount)
  const displayName = rawName || t('untitledDocument', { defaultValue: '未命名文档' })

  // 多文档队列时给副标题加"还有 X 个待确认"提示，让用户感知到队列存在
  // （W2.5 T9 顺手补：W2 T5 引入 FIFO 队列，store 已有 pendingCount 但 UI 未消费）
  const remainingAfterCurrent = Math.max(0, pendingCount - 1)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settleTabDocCloseConfirm('cancel')
      }}
    >
      <DialogContent className="sm:max-w-md">
        <ContextDialogHeader
          className="px-0 pt-0"
          icon={<FileText className="h-7 w-7" />}
          title={t('closeConfirm.title', { defaultValue: '关闭文档' })}
          description={(
            <div className="space-y-2 pt-1">
              <p className="m-0 text-body text-muted-foreground/80">
                {t('closeConfirm.message', {
                  defaultValue: '"{{name}}" 有未保存的改动，确认关闭吗？',
                  name: displayName,
                })}
              </p>
              {remainingAfterCurrent > 0 ? (
                <p className="m-0 text-body text-muted-foreground/60">
                  {t('closeConfirm.queueHint', {
                    defaultValue: '还有 {{count}} 个文档待确认',
                    count: remainingAfterCurrent,
                  })}
                </p>
              ) : null}
              <p className="m-0 text-body text-muted-foreground/60">
                {t('closeConfirm.chooseHint', {
                  defaultValue: '"放弃修改"会丢弃本地未提交的内容，"保存并关闭"会先尝试保存。',
                })}
              </p>
            </div>
          )}
        />
        <DialogFooter className="gap-2 sm:space-x-2">
          <Button
            type="button"
            variant="outline"
            className="w-full text-body sm:w-auto"
            onClick={() => settleTabDocCloseConfirm('cancel')}
            autoFocus
          >
            {t('closeConfirm.cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            className="w-full text-body sm:w-auto"
            onClick={() => settleTabDocCloseConfirm('discard')}
          >
            {t('closeConfirm.discard', { defaultValue: '放弃修改' })}
          </Button>
          <Button
            type="button"
            variant="default"
            className="w-full text-body sm:w-auto"
            onClick={() => settleTabDocCloseConfirm('save')}
          >
            {t('closeConfirm.saveAndClose', { defaultValue: '保存并关闭' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
