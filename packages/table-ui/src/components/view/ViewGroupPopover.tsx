import React, { useMemo } from 'react'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@tabtin/smartsheet-ui'
import type { ViewGroup } from '../../types'
import { ViewGroupRulesEditor } from './ViewGroupRulesEditor'
import {
  createGroupRule,
  getGroupableFields,
  getMaxGroups,
  mapGroupsToEditorRules,
  mapFieldsToGroupEditorFields,
} from '../../utils/groupHelpers'

export interface GroupPanelTexts {
  descriptionKanban: string
  descriptionDefault: string
  emptyGroupPlacement: string
  title: string
  empty: string
  add: string
  remove: string
  fieldPlaceholder: string
  orderAsc: string
  orderDesc: string
  moveUp: string
  moveDown: string
  searchPlaceholder: string
  noResults: string
}

export interface GroupFieldLike {
  id: string
  name: string
  field_type: string
  is_hidden?: boolean
  options?: Record<string, unknown>
}

export interface ViewGroupPopoverDraft {
  groups?: ViewGroup[]
}

export interface ViewGroupPopoverStoreActions {
  initializeDraft: (viewId: string) => void
  setDraftGroups: (viewId: string, groups: ViewGroup[]) => void
  applyDraft: (viewId: string) => Promise<void> | void
}

export interface ViewGroupPopoverView {
  id: string
  view_type?: string
}

export interface ViewGroupPopoverProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  viewId: string | null
  fields: GroupFieldLike[]
  views: ViewGroupPopoverView[]
  draft: ViewGroupPopoverDraft | undefined
  store: ViewGroupPopoverStoreActions
  texts: GroupPanelTexts
  footer?: React.ReactNode
  triggerTooltip?: React.ReactNode
  children?: React.ReactNode
  disabled?: boolean
}

export const ViewGroupPopover: React.FC<ViewGroupPopoverProps> = ({
  open,
  onOpenChange,
  viewId,
  fields,
  views,
  draft,
  store,
  texts,
  footer,
  triggerTooltip,
  children,
  disabled = false,
}) => {
  const currentView = useMemo(
    () => views.find(view => view.id === viewId) ?? null,
    [views, viewId],
  )

  React.useEffect(() => {
    if (viewId) store.initializeDraft(viewId)
  }, [viewId, store])

  const groups = draft?.groups ?? []
  const maxGroups = getMaxGroups(currentView?.view_type)
  const groupable = useMemo(
    () => getGroupableFields(fields, currentView?.view_type),
    [fields, currentView?.view_type],
  )

  const fieldIdByName = useMemo(() => {
    const map = new Map<string, string>()
    fields.forEach(f => map.set(f.name, f.id))
    return map
  }, [fields])

  const updateGroups = (nextGroups: ViewGroup[]) => {
    if (!viewId) return
    store.setDraftGroups(viewId, nextGroups)
  }

  const handleAddGroup = () => {
    if (!viewId || groups.length >= maxGroups || groupable.length === 0) return
    updateGroups([...groups, createGroupRule(groupable[0].id) as ViewGroup])
  }

  const handleRemoveGroup = (index: number) => {
    updateGroups(groups.filter((_, idx) => idx !== index))
  }

  const handleMove = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return
    const next = [...groups]
    const [item] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, item)
    updateGroups(next)
  }

  const editorFields = useMemo(
    () => mapFieldsToGroupEditorFields(groupable),
    [groupable],
  )

  const editorRules = useMemo(
    () => mapGroupsToEditorRules(groups, groupable, fieldIdByName),
    [groups, groupable, fieldIdByName],
  )

  const tipText =
    currentView?.view_type === 'kanban'
      ? texts.descriptionKanban
      : texts.descriptionDefault

  const handlePopoverInteractOutside = React.useCallback((event: Event) => {
    const target = event.target
    const el =
      target instanceof Element
        ? target
        : target instanceof Node
          ? target.parentElement
          : null
    if (!el) return
    if (el.closest('[data-radix-popper-content-wrapper], [cmdk-root]')) {
      event.preventDefault()
    }
  }, [])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {triggerTooltip ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>{children}</PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{triggerTooltip}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      )}
      <PopoverContent
        side="bottom"
        align="start"
        className="min-w-[400px] max-w-screen-md p-0"
        onInteractOutside={handlePopoverInteractOutside}
      >
        <div className="space-y-3 p-4">
          <div className="text-body text-muted-foreground">{tipText}</div>
          <div role="note" className="text-caption text-muted-foreground">
            {texts.emptyGroupPlacement}
          </div>

          <ViewGroupRulesEditor
            fields={editorFields}
            rules={editorRules}
            maxRules={maxGroups}
            allowDirection={currentView?.view_type !== 'kanban'}
            allowReorder={currentView?.view_type !== 'kanban'}
            onAddRule={handleAddGroup}
            onRemoveRule={handleRemoveGroup}
            onMoveRule={handleMove}
            onUpdateRule={(index, patch) => {
              const nextGroups = groups.map((item, idx) =>
                idx === index
                  ? {
                      ...item,
                      field_id: patch.fieldId ?? item.field_id ?? '',
                      direction: patch.direction ?? (item.direction === 'desc' ? 'desc' : 'asc'),
                    }
                  : item,
              )
              updateGroups(nextGroups)
            }}
            texts={{
              title: texts.title,
              empty: texts.empty,
              add: texts.add,
              remove: texts.remove,
              fieldPlaceholder: texts.fieldPlaceholder,
              orderAsc: texts.orderAsc,
              orderDesc: texts.orderDesc,
              moveUp: texts.moveUp,
              moveDown: texts.moveDown,
              searchPlaceholder: texts.searchPlaceholder,
              noResults: texts.noResults,
            }}
            disabled={disabled}
          />
        </div>
        {footer ? (
          <div className="border-t px-4 py-3">{footer}</div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
