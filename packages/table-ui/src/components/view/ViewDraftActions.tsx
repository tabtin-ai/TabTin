import React from 'react'
import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui'

export interface ViewDraftActionsProps {
  onClear: () => void
  onCancel: () => void
  onSave: () => void
  onSaveAs: () => void
  canClear: boolean
  canCancel: boolean
  canSave: boolean
  canSaveAs: boolean
  /** 保存按钮禁用时的具体原因；提供后支持悬停与键盘聚焦查看。 */
  saveDisabledReason?: string | null
  translate: (key: string, options?: Record<string, unknown>) => string
}

export const ViewDraftActions: React.FC<ViewDraftActionsProps> = ({
  onClear,
  onCancel,
  onSave,
  onSaveAs,
  canClear,
  canCancel,
  canSave,
  canSaveAs,
  saveDisabledReason,
  translate: t,
}) => {
  const saveButton = (
    <Button
      variant="default"
      size="sm"
      className="h-7 text-body"
      onClick={onSave}
      disabled={!canSave}
    >
      {t('view:actions.save')}
    </Button>
  )

  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-body"
        onClick={onClear}
        disabled={!canClear}
      >
        {t('view:actions.clear')}
      </Button>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-body"
          onClick={onCancel}
          disabled={!canCancel}
        >
          {t('view:actions.cancel')}
        </Button>
        {!canSave && saveDisabledReason ? (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className="inline-flex"
                  tabIndex={0}
                  aria-label={`${t('view:actions.save')}: ${saveDisabledReason}`}
                >
                  {saveButton}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top">{saveDisabledReason}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : saveButton}
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-body"
          onClick={onSaveAs}
          disabled={!canSaveAs}
        >
          {t('view:actions.saveAs')}
        </Button>
      </div>
    </div>
  )
}
