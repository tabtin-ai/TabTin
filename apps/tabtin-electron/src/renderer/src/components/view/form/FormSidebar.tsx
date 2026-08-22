import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useDroppable } from '@dnd-kit/core'
import { Plus, PlusCircle, MinusCircle, Lock } from 'lucide-react'
import { Button, cn, ScrollArea, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@tabtin/smartsheet-ui'
import type { FormFieldMeta } from '@tabtin/table-ui'
import { FieldTypeIcon } from '@components/field/FieldTypeIcon'
import { useFieldSettingStore } from '@/stores/useFieldSettingStore'
import { DraggableItem } from './DraggableItem'
import { FORM_SIDEBAR_DROPPABLE_ID } from './constant'

// ---------------------------------------------------------------------------
// FormSidebar — 左侧字段管理面板
// ---------------------------------------------------------------------------

export interface FormSidebarProps {
  hiddenFields: FormFieldMeta[]
  unavailableFields: FormFieldMeta[]
  onAddAll: () => void
  onRemoveAll: () => void
  /** 单击隐藏字段时将其添加到表单 */
  onAddField?: (fieldId: string) => void
  /** 当前可见字段列表（用于判断"全部移除"是否可用），由 FormEditor 传入 */
  formFields?: FormFieldMeta[]
  /** 是否正在拖拽（控制底部提示区高亮） */
  isDragging?: boolean
  className?: string
}

export const FormSidebar: React.FC<FormSidebarProps> = ({
  hiddenFields,
  unavailableFields,
  onAddAll,
  onRemoveAll,
  onAddField,
  formFields,
  isDragging,
  className,
}) => {
  const { t } = useTranslation('view')
  const openForAdd = useFieldSettingStore(s => s.openForAdd)

  const handleAddNewField = useCallback(() => {
    openForAdd()
  }, [openForAdd])

  const removableCount = useMemo(
    () => formFields?.filter(f => !f.protected).length ?? -1,
    [formFields],
  )

  const { setNodeRef, isOver } = useDroppable({
    id: FORM_SIDEBAR_DROPPABLE_ID,
    data: { isContainer: true },
  })

  return (
    <div
      className={cn(
        'flex h-full w-64 shrink-0 flex-col border-r border-border bg-muted/20',
        className,
      )}
    >
      {/* 头部 */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-body font-medium">
          {t('form.sidebar.title', '字段')}
        </h3>
        <span className="text-caption text-muted-foreground">
          {hiddenFields.length} {t('form.sidebar.hiddenCount', '已隐藏')}
        </span>
      </div>

      {/* 批量操作 */}
      <div className="flex gap-2 border-b border-border px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 flex-1 gap-1 text-caption"
          onClick={onAddAll}
          disabled={hiddenFields.length === 0}
        >
          <PlusCircle className="h-3.5 w-3.5" />
          {t('form.sidebar.addAll', '全部添加')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 flex-1 gap-1 text-caption"
          onClick={onRemoveAll}
          disabled={removableCount === 0}
        >
          <MinusCircle className="h-3.5 w-3.5" />
          {t('form.sidebar.removeAll', '全部移除')}
        </Button>
      </div>

      {/* droppable ref 在 ScrollArea 外层，矩形由 flex-1 固定高度决定，
          不受内部内容增减影响，避免拖拽期间矩形失效 */}
      <div
        ref={setNodeRef}
        className={cn(
          'flex-1 overflow-hidden transition-colors',
          isOver && 'bg-primary/5',
        )}
      >
        <ScrollArea className="h-full">
          <div className="space-y-1.5 px-3 py-3">
            {/* 隐藏字段 — 可拖入主区 */}
            {hiddenFields.map(field => (
              <DraggableItem key={field.id} id={field.id} field={field}>
                <div
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-transparent bg-background px-3 py-2 text-body transition-colors hover:border-primary/40 hover:bg-accent/60"
                  onClick={() => onAddField?.(field.id)}
                >
                  <FieldTypeIcon type={field.field_type} className="shrink-0" />
                  <span className="truncate">{field.name}</span>
                </div>
              </DraggableItem>
            ))}

            {/* 不可用字段 — 灰显不可拖，带 Tooltip */}
            {unavailableFields.length > 0 && (
              <>
                {hiddenFields.length > 0 && (
                  <div className="my-2 border-t border-dashed border-border/60" />
                )}
                <p className="px-1 text-caption text-muted-foreground/60">
                  {t('form.sidebar.unavailableLabel', '不可用字段')}
                </p>
                {unavailableFields.map(field => (
                  <TooltipProvider key={field.id} delayDuration={200}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div
                          className="flex cursor-not-allowed items-center gap-2 rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-body opacity-50"
                        >
                          <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                          <FieldTypeIcon
                            type={field.field_type}
                            className="shrink-0 opacity-50"
                          />
                          <span className="truncate text-muted-foreground">
                            {field.name}
                          </span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        {t('form.sidebar.unavailableTooltip', '计算字段、查找引用字段不支持表单填写')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ))}
              </>
            )}

            {/* 底部虚线提示区 — 拖拽时高亮 */}
            <div
              className={cn(
                'mt-2 flex h-16 w-full items-center justify-center rounded-md border-2 border-dashed text-caption text-muted-foreground transition-colors',
                isDragging
                  ? 'border-primary/40 bg-primary/5 text-primary/80'
                  : 'border-border/40',
              )}
            >
              {t('form.sidebar.hideFieldTip', '将字段拖到此处从表单移除')}
            </div>

            {/* 空状态 */}
            {hiddenFields.length === 0 && unavailableFields.length === 0 && (
              <p className="py-6 text-center text-caption text-muted-foreground">
                {t('form.sidebar.allFieldsVisible', '所有字段已添加到表单')}
              </p>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* 添加新字段 */}
      <div className="border-t border-border px-3 py-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1.5"
          onClick={handleAddNewField}
        >
          <Plus className="h-3.5 w-3.5" />
          {t('form.sidebar.addNewField', '添加新字段')}
        </Button>
      </div>
    </div>
  )
}

export default FormSidebar
