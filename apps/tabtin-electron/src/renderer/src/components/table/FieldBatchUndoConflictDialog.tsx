/**
 * FieldBatchUndoConflictDialog
 *
 * W1.4 / 字段批量恢复 409 (FIELD_RESTORE_NOT_SUPPORTED)
 *
 * 用户调 tableUndo 撤销表级最近一次操作时，后端返回 409 + 全量分类:
 * - `restorable_fields[]`:简单字段,可单独 Ctrl+Z 恢复
 * - `unrestorable_fields[]`:复杂字段,需走「版本历史」还原
 *
 * 本对话框把分类完整呈现给用户,提供「打开版本历史」快捷入口。
 *
 * 文案严格遵守 W0-7 词表:
 * - 复杂字段:用「无法撤销」+「需走版本历史」(不用「回滚」)
 * - 简单字段:用「可单独 Ctrl+Z 恢复」(对应「撤销」)
 */
import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Button,
  ScrollArea,
  Separator,
  cn,
} from '@tabtin/smartsheet-ui'
import { Undo2, History, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface FieldBatchUndoConflictItem {
  id: string
  name: string
  type: string
}

interface FieldBatchUndoConflictDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 可单独 Ctrl+Z 恢复的简单字段(本期 11 种白名单) */
  restorableFields: FieldBatchUndoConflictItem[]
  /** 需走版本历史的不可快速恢复字段 */
  unrestorableFields: FieldBatchUndoConflictItem[]
  /** 「打开版本历史」回调 */
  onOpenVersionHistory?: () => void
}

const FieldList: React.FC<{
  items: FieldBatchUndoConflictItem[]
  emptyText: string
  toneClassName?: string
}> = ({ items, emptyText, toneClassName }) => {
  const { t } = useTranslation('field')
  if (items.length === 0) {
    return <div className="text-body text-muted-foreground/80">{emptyText}</div>
  }
  return (
    <ul className="space-y-1">
      {items.map((f) => (
        <li
          key={f.id}
          className={cn(
            'flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5',
            toneClassName,
          )}
        >
          <span className="truncate font-medium text-body">{f.name}</span>
          <span className="text-caption text-muted-foreground/80 shrink-0">
            ({t(`types.${f.type}`, { defaultValue: f.type })})
          </span>
        </li>
      ))}
    </ul>
  )
}

export const FieldBatchUndoConflictDialog: React.FC<FieldBatchUndoConflictDialogProps> = ({
  open,
  onOpenChange,
  restorableFields,
  unrestorableFields,
  onOpenVersionHistory,
}) => {
  const { t } = useTranslation(['tabdata', 'field'])
  const restorableCount = restorableFields.length
  const unrestorableCount = unrestorableFields.length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0" />
            {t('tabdata:field.batchRestore.title')}
          </DialogTitle>
          <DialogDescription>
            {t('tabdata:field.batchRestore.summary', {
              restorableCount,
              unrestorableCount,
            })}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[360px] pr-2">
          <div className="space-y-4">
            {restorableCount > 0 && (
              <section>
                <div className="mb-1.5 flex items-center gap-1.5 text-body font-medium text-info">
                  <Undo2 className="h-4 w-4 shrink-0" />
                  {t('tabdata:field.batchRestore.restorableSection', {
                    count: restorableCount,
                  })}
                </div>
                <FieldList
                  items={restorableFields}
                  emptyText=""
                  toneClassName="border border-info/20"
                />
              </section>
            )}

            {restorableCount > 0 && unrestorableCount > 0 && <Separator />}

            {unrestorableCount > 0 && (
              <section>
                <div className="mb-1.5 flex items-center gap-1.5 text-body font-medium text-warning">
                  <History className="h-4 w-4 shrink-0" />
                  {t('tabdata:field.batchRestore.unrestorableSection', {
                    count: unrestorableCount,
                  })}
                </div>
                <FieldList
                  items={unrestorableFields}
                  emptyText=""
                  toneClassName="border border-warning/20"
                />
                <p className="mt-2 text-caption text-muted-foreground/80">
                  {t('tabdata:field.batchRestore.complexFieldHint')}
                </p>
              </section>
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('tabdata:field.batchRestore.close')}
          </Button>
          {onOpenVersionHistory && unrestorableCount > 0 && (
            <Button
              type="button"
              variant="default"
              onClick={() => {
                onOpenVersionHistory()
                onOpenChange(false)
              }}
            >
              <History className="mr-1.5 h-3.5 w-3.5" />
              {t('tabdata:field.batchRestore.openVersionHistory')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
