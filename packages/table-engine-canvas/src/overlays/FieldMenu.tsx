/**
 * FieldMenu
 *
 * Column header context menu with field operations.
 */
import React, { Fragment, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import { isPrimaryFieldAllowedType } from '@tabtin/table-engine'
import { useClickAway } from 'react-use'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpDown,
  Copy,
  Edit,
  EyeOff,
  Filter,
  FreezeColumn,
  LayoutList,
  Star,
  Trash2,
} from '../icons/inlineIcons'
import {
  OverlayMenuGroup,
  OverlayMenuItem,
  OverlayMenuList,
  OverlayMenuSeparator,
} from './menuPrimitives'
import { useGridOverlayStore } from './store'
import { useGridOverlayFloatingPosition } from './useGridOverlayFloatingPosition'

import { isPrimaryMouseButton, stopOverlayPointerEvent } from './overlayPointerEvents'

const iconClassName = 'mr-2 h-4 w-4'

export const FIELD_MENU_VIEWPORT_CLASS_NAME =
  'z-modal w-[min(15rem,calc(100vw-1rem))] rounded-md border bg-popover shadow-md'
export const FIELD_MENU_LIST_VIEWPORT_CLASS_NAME =
  'max-h-[calc(100dvh-1rem)] overflow-y-auto'

// ---------------------------------------------------------------------------
// Labels interface (i18n ready)
// ---------------------------------------------------------------------------

export interface FieldMenuLabels {
  editField?: string
  duplicateField?: string
  insertFieldLeft?: string
  insertFieldRight?: string
  sortField?: string
  filterField?: string
  groupField?: string
  freezeField?: string
  setPrimaryField?: string
  primaryField?: string
  hideField?: string
  hideAllSelectedFields?: string
  deleteField?: string
  deleteAllSelectedFields?: string
}

const defaultLabels: Required<FieldMenuLabels> = {
  editField: 'Edit field',
  duplicateField: 'Duplicate field',
  insertFieldLeft: 'Insert left',
  insertFieldRight: 'Insert right',
  sortField: 'Sort',
  filterField: 'Filter',
  groupField: 'Group',
  freezeField: 'Freeze up to this column',
  setPrimaryField: 'Set as primary field',
  primaryField: 'Primary field',
  hideField: 'Hide field',
  hideAllSelectedFields: 'Hide all selected fields',
  deleteField: 'Delete field',
  deleteAllSelectedFields: 'Delete all selected fields',
}

// ---------------------------------------------------------------------------
// Callbacks interface
// ---------------------------------------------------------------------------

export interface FieldMenuCallbacks {
  onEditField?: (field: string) => void
  onDuplicateField?: (field: string) => void
  onInsertField?: (field: string, position: 'left' | 'right') => void
  onSortField?: (field: string) => void
  onFilterField?: (field: string) => void
  onGroupField?: (field: string) => void
  onFreezeField?: (field: string) => void
  onSetPrimaryField?: (field: string) => void
  onHideFields?: (fields: string[]) => void
  onDeleteFields?: (fields: string[]) => void
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const FieldMenu: React.FC<{
  labels?: FieldMenuLabels
  callbacks?: FieldMenuCallbacks
  /** Grid root ([data-t-grid-container]) for menu coordinate → viewport mapping */
  anchorRef?: RefObject<HTMLElement | null>
  ownerId?: string
}> = ({ labels: _labels, callbacks, anchorRef, ownerId }) => {
  const labels = { ...defaultLabels, ..._labels }
  const { headerMenu, closeHeaderMenu } = useGridOverlayStore()
  const fieldSettingRef = useRef<HTMLDivElement>(null)

  useClickAway(fieldSettingRef, () => {
    const currentHeaderMenu = useGridOverlayStore.getState().headerMenu
    if (!currentHeaderMenu?.ownerId || !ownerId || currentHeaderMenu.ownerId === ownerId) {
      closeHeaderMenu()
    }
  })

  const { fields, fieldTypes, isPrimary, position, onSelectionClear } = headerMenu ?? {}
  const isOwner = !headerMenu?.ownerId || !ownerId || headerMenu.ownerId === ownerId
  const isSingle = (fields?.length ?? 0) === 1
  const field = fields?.[0] ?? ''
  const fieldType = fieldTypes?.[0] ?? ''
  const hasPrimary = isPrimary?.some(Boolean) ?? false
  const hasFields = (fields?.length ?? 0) > 0
  const canSetPrimary = isSingle && !hasPrimary && isPrimaryFieldAllowedType(fieldType)

  const handleAnchorUnavailable = React.useCallback(() => {
    closeHeaderMenu()
  }, [closeHeaderMenu])

  const { setFloatingRef, floatingStyles } = useGridOverlayFloatingPosition({
    open: Boolean(headerMenu && isOwner && hasFields),
    anchor: position,
    anchorRef,
    placement: 'bottom-start',
    onAnchorUnavailable: handleAnchorUnavailable,
  })

  const setFieldMenuRef = React.useCallback((node: HTMLDivElement | null) => {
    fieldSettingRef.current = node
    setFloatingRef(node)
  }, [setFloatingRef])

  if (!headerMenu) return null
  if (!isOwner) return null
  if (!fields?.length) return null

  interface MenuItem {
    key: string
    name: string
    icon: React.ReactNode
    hidden?: boolean
    disabled?: boolean
    className?: string
    onClick: () => void
  }

  const menuGroups: MenuItem[][] = [
    // Group 1: Edit, Duplicate
    [
      {
        key: 'edit',
        name: labels.editField,
        icon: <Edit className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onEditField,
        onClick: () => callbacks?.onEditField?.(field),
      },
      {
        key: 'duplicate',
        name: labels.duplicateField,
        icon: <Copy className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onDuplicateField,
        onClick: () => callbacks?.onDuplicateField?.(field),
      },
    ],
    // Group 2: Insert left/right
    [
      {
        key: 'insert-left',
        name: labels.insertFieldLeft,
        icon: <ArrowLeft className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onInsertField,
        onClick: () => callbacks?.onInsertField?.(field, 'left'),
      },
      {
        key: 'insert-right',
        name: labels.insertFieldRight,
        icon: <ArrowRight className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onInsertField,
        onClick: () => callbacks?.onInsertField?.(field, 'right'),
      },
    ],
    // Group 3: Sort, Filter, Group
    [
      {
        key: 'sort',
        name: labels.sortField,
        icon: <ArrowUpDown className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onSortField,
        onClick: () => callbacks?.onSortField?.(field),
      },
      {
        key: 'filter',
        name: labels.filterField,
        icon: <Filter className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onFilterField,
        onClick: () => callbacks?.onFilterField?.(field),
      },
      {
        key: 'group',
        name: labels.groupField,
        icon: <LayoutList className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onGroupField,
        onClick: () => callbacks?.onGroupField?.(field),
      },
    ],
    // Group 4: Freeze, Hide
    [
      {
        key: 'freeze',
        name: labels.freezeField,
        icon: <FreezeColumn className={iconClassName} />,
        hidden: !isSingle || !callbacks?.onFreezeField,
        onClick: () => callbacks?.onFreezeField?.(field),
      },
      {
        key: 'set-primary',
        name: hasPrimary ? labels.primaryField : labels.setPrimaryField,
        icon: <Star className={iconClassName} />,
        // 已是主字段：展示只读「主字段」；不可设为主字段的类型：整项隐藏
        hidden:
          !isSingle ||
          !callbacks?.onSetPrimaryField ||
          (!hasPrimary && !isPrimaryFieldAllowedType(fieldType)),
        disabled: !canSetPrimary,
        onClick: () => callbacks?.onSetPrimaryField?.(field),
      },
      {
        key: 'hide',
        name: fields.length > 1 ? labels.hideAllSelectedFields : labels.hideField,
        icon: <EyeOff className={iconClassName} />,
        hidden: !callbacks?.onHideFields,
        onClick: () => callbacks?.onHideFields?.(fields),
      },
    ],
    // Group 5: Delete
    [
      {
        key: 'delete',
        name: fields.length > 1 ? labels.deleteAllSelectedFields : labels.deleteField,
        icon: <Trash2 className={iconClassName} />,
        hidden: !callbacks?.onDeleteFields,
        disabled: hasPrimary,
        className: 'text-destructive aria-selected:text-destructive',
        onClick: () => callbacks?.onDeleteFields?.(fields),
      },
    ],
  ]
    .map((items) => items.filter((item) => !item.hidden))
    .filter((items) => items.length > 0)

  if (menuGroups.length === 0) return null

  /** Execute a menu item action, then close the menu. */
  const executeItem = (item: MenuItem) => {
    if (item.disabled) return
    item.onClick()
    onSelectionClear?.()
    closeHeaderMenu()
  }

  const menu = (
    <div
      ref={setFieldMenuRef}
      role="menu"
      data-grid-overlay="field-menu"
      data-grid-overlay-owner={headerMenu.ownerId}
      className={FIELD_MENU_VIEWPORT_CLASS_NAME}
      style={floatingStyles}
      onMouseDown={stopOverlayPointerEvent}
      onPointerDown={stopOverlayPointerEvent}
    >
      <OverlayMenuList className={FIELD_MENU_LIST_VIEWPORT_CLASS_NAME}>
        {menuGroups.map((items, index) => {
          const nextItems = menuGroups[index + 1] ?? []
          if (!items.length) return null

          return (
            <Fragment key={index}>
              <OverlayMenuGroup>
                {items.map((item) => (
                  <OverlayMenuItem
                    className={item.className}
                    disabled={item.disabled}
                    key={item.key}
                    onMouseDown={(event) => {
                      stopOverlayPointerEvent(event)
                      if (!isPrimaryMouseButton(event) || item.disabled) return
                      executeItem(item)
                    }}
                  >
                    {item.icon}
                    {item.name}
                  </OverlayMenuItem>
                ))}
              </OverlayMenuGroup>
              {nextItems.length > 0 && <OverlayMenuSeparator />}
            </Fragment>
          )
        })}
      </OverlayMenuList>
    </div>
  )

  if (typeof document === 'undefined') {
    return menu
  }

  return createPortal(menu, document.body)
}
