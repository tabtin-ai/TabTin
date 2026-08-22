import React from 'react'
import {
  Button,
  PopoverContent,
  ScrollArea,
  Switch,
  cn,
} from '@tabtin/smartsheet-ui'
import { Lock } from 'lucide-react'
import { PopoverSearchInput } from '../common/PopoverSearchInput'
import type { Field } from '../../types'

export interface HideFieldsPopoverContentProps {
  search: string
  onSearchChange: (value: string) => void
  filteredFields: Field[]
  visibleFieldIds: string[]
  onToggleField: (fieldId: string) => void
  onShowAll: () => void
  onHideAll: () => void
  onSave: () => void
  canSave: boolean
  /** 只读：禁止切换字段可见性，保存按钮仍由 canSave 控制 */
  readOnly?: boolean
  lockPrimaryVisibility?: boolean
  translate: (key: string, options?: Record<string, unknown>) => string
  onInteractOutside?: (event: Event) => void
}

export const HideFieldsPopoverContent: React.FC<HideFieldsPopoverContentProps> = ({
  search,
  onSearchChange,
  filteredFields,
  visibleFieldIds,
  onToggleField,
  onShowAll,
  onHideAll,
  onSave,
  canSave,
  readOnly = false,
  lockPrimaryVisibility = false,
  translate: t,
  onInteractOutside,
}) => (
  <PopoverContent
    side="bottom"
    align="start"
    className="w-[280px] p-0"
    onInteractOutside={onInteractOutside}
  >
    <PopoverSearchInput
      value={search}
      onValueChange={onSearchChange}
      placeholder={t('view:hideFieldsPanel.searchPlaceholder')}
    />
    <div className="flex items-center justify-between border-b px-3 py-1.5">
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-body"
        disabled={readOnly}
        onClick={onShowAll}
      >
        {t('view:hideFieldsPanel.showAll')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-1.5 text-body"
        disabled={readOnly}
        onClick={onHideAll}
      >
        {t('view:hideFieldsPanel.hideAll')}
      </Button>
    </div>
    <ScrollArea className="max-h-[320px]">
      <div className="p-1">
        {filteredFields.length === 0 ? (
          <div className="px-3 py-4 text-center text-body text-muted-foreground">
            {search.trim()
              ? t('view:hideFieldsPanel.noResults')
              : t('view:actions.hideFields')}
          </div>
        ) : filteredFields.map(field => {
          const checked = visibleFieldIds.includes(field.id)
          const isLocked = lockPrimaryVisibility && field.is_primary
          const isToggleDisabled = readOnly || isLocked
          return (
            <div
              key={field.id}
              className={cn(
                'flex items-center justify-between rounded-sm px-2 py-1.5 text-body hover:bg-accent/50',
                isToggleDisabled ? 'cursor-default text-muted-foreground' : 'cursor-pointer',
              )}
              onClick={() => {
                if (!isToggleDisabled) onToggleField(field.id)
              }}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{field.name}</span>
                {isLocked && (
                  <Lock
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-label={t('view:hideFieldsPanel.primaryLocked', {
                      defaultValue: 'Primary field cannot be hidden',
                    })}
                  />
                )}
              </span>
              <Switch
                checked={checked}
                disabled={isToggleDisabled}
                onPointerDown={e => e.stopPropagation()}
                onClick={e => e.stopPropagation()}
                onCheckedChange={nextChecked => {
                  if (!isToggleDisabled && nextChecked !== checked) onToggleField(field.id)
                }}
                className="h-4 w-8"
              />
            </div>
          )
        })}
      </div>
    </ScrollArea>
    <div className="border-t px-3 py-2">
      <Button
        size="sm"
        className="w-full"
        onClick={onSave}
        disabled={!canSave}
      >
        {t('common:save')}
      </Button>
    </div>
  </PopoverContent>
)
