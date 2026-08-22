/**
 * RecordMenu
 *
 * Context menu for record (row) actions.
 */
import React, { Fragment, useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import { useClickAway } from 'react-use'
import {
  ArrowDown,
  ArrowUp,
  Copy,
  History,
  ListOrdered,
  MessageSquare,
  Trash2,
} from '../icons/inlineIcons'
import {
  OverlayMenuGroup,
  OverlayMenuInput,
  OverlayMenuItem,
  OverlayMenuList,
  OverlayMenuSeparator,
} from './menuPrimitives'
import { isPrimaryMouseButton, stopOverlayPointerEvent } from './overlayPointerEvents'
import { useGridOverlayStore } from './store'
import { useGridOverlayFloatingPosition } from './useGridOverlayFloatingPosition'

const iconClassName = 'mr-2 h-4 w-4 shrink-0'

// ---------------------------------------------------------------------------
// Insert record quantity input sub-component
// ---------------------------------------------------------------------------
interface IInsertRecordRenderProps {
  label: string
  rowUnit: string
  onClick: (num: number) => void
  icon: React.ReactElement
}

const InsertRecordRender: React.FC<IInsertRecordRenderProps> = ({
  label,
  rowUnit,
  onClick,
  icon,
}) => {
  const [num, setNumber] = useState(1)
  const [hint, setHint] = useState<string | null>(null)
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showHint = useCallback((msg: string) => {
    setHint(msg)
    if (hintTimer.current) clearTimeout(hintTimer.current)
    hintTimer.current = setTimeout(() => setHint(null), 2000)
  }, [])

  const handleChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    event.stopPropagation()
    event.preventDefault()

    const rawValue = Number(event.target.value)
    const nextValue = Number.isFinite(rawValue) ? Math.abs(Math.round(rawValue)) : 1
    const clamped = Math.min(1000, Math.max(1, nextValue))
    if (nextValue < 1) {
      showHint('Min: 1')
    } else if (nextValue > 1000) {
      showHint('Max: 1000')
    }
    setNumber(clamped)
  }, [showHint])

  const handleInsert = useCallback(() => {
    onClick(num)
  }, [num, onClick])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      handleInsert()
    }
  }, [handleInsert])

  const handleMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    stopOverlayPointerEvent(event)
    if (!isPrimaryMouseButton(event)) return
    if (event.target instanceof Element && event.target.closest('input')) {
      return
    }
    handleInsert()
  }, [handleInsert])

  return (
    <div
      role="button"
      tabIndex={0}
      className="flex h-9 w-full items-center rounded-sm px-4 py-2 text-left transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      onPointerDown={stopOverlayPointerEvent}
    >
      {icon}
      <div className="flex flex-1 items-center text-body">
        <span>{label.replace('{{count}}', '')}</span>
        <div className="relative mx-1">
          <OverlayMenuInput
            inputMode="numeric"
            value={num}
            onKeyDown={(e: React.KeyboardEvent) => e.stopPropagation()}
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation()
            }}
            onChange={handleChange}
          />
          {hint && (
            <span className="absolute -bottom-5 left-0 whitespace-nowrap text-caption text-destructive">
              {hint}
            </span>
          )}
        </div>
        <span>{rowUnit}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RecordMenu component
// ---------------------------------------------------------------------------

export interface RecordMenuLabels {
  insertAbove?: string
  insertBelow?: string
  rowUnit?: string
  addSubRecord?: string
  duplicate?: string
  copyLink?: string
  comment?: string
  viewHistory?: string
  sendToChat?: string
  sendMultipleToChat?: string
  delete?: string
  deleteMultiple?: string
}

const defaultLabels: Required<RecordMenuLabels> = {
  insertAbove: 'Insert above',
  insertBelow: 'Insert below',
  rowUnit: 'rows',
  addSubRecord: 'Add sub-record',
  duplicate: 'Duplicate record',
  copyLink: 'Copy link',
  comment: 'Comment',
  viewHistory: 'View history',
  sendToChat: 'Send to chat',
  sendMultipleToChat: 'Send selected records to chat',
  delete: 'Delete record',
  deleteMultiple: 'Delete selected records',
}

export const RecordMenu: React.FC<{
  labels?: RecordMenuLabels
  anchorRef?: RefObject<HTMLElement | null>
}> = ({ labels: _labels, anchorRef }) => {
  const labels = { ...defaultLabels, ..._labels }
  const { recordMenu, closeRecordMenu } = useGridOverlayStore()
  const recordMenuRef = useRef<HTMLDivElement>(null)

  useClickAway(recordMenuRef, () => {
    closeRecordMenu()
  })

  const { rowData, isMultipleSelected, position } = recordMenu ?? {}
  const isSpecialRow =
    typeof (rowData as { __rowType?: unknown } | undefined)?.__rowType === 'string' &&
    ((rowData as { __rowType?: string }).__rowType?.length ?? 0) > 0
  const isOpen = Boolean(recordMenu && (rowData || isMultipleSelected) && (!isSpecialRow || isMultipleSelected))

  const handleAnchorUnavailable = useCallback(() => {
    closeRecordMenu()
  }, [closeRecordMenu])

  const { setFloatingRef, floatingStyles } = useGridOverlayFloatingPosition({
    open: isOpen,
    anchor: position,
    anchorRef,
    placement: 'bottom-start',
    onAnchorUnavailable: handleAnchorUnavailable,
  })

  const setRecordMenuRef = useCallback((node: HTMLDivElement | null) => {
    recordMenuRef.current = node
    setFloatingRef(node)
  }, [setFloatingRef])

  if (!recordMenu) return null
  if (!rowData && !isMultipleSelected) return null
  if (isSpecialRow && !isMultipleSelected) return null

  interface MenuItem {
    key: string
    name: string
    icon: React.ReactNode
    hidden?: boolean
    className?: string
    render?: React.ReactNode
    onClick: () => void
  }

  const menuItemGroups: MenuItem[][] = [
    // Group 1: Insert above/below
    [
      {
        key: 'insert-above',
        name: labels.insertAbove,
        icon: <ArrowUp className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.insertRecord || isSpecialRow,
        render: (
          <InsertRecordRender
            label={labels.insertAbove}
            rowUnit={labels.rowUnit}
            onClick={(num) => {
              recordMenu.insertRecord?.('before', num)
              closeRecordMenu()
            }}
            icon={<ArrowUp className={iconClassName} />}
          />
        ),
        onClick: () => {},
      },
      {
        key: 'insert-below',
        name: labels.insertBelow,
        icon: <ArrowDown className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.insertRecord || isSpecialRow,
        render: (
          <InsertRecordRender
            label={labels.insertBelow}
            rowUnit={labels.rowUnit}
            onClick={(num) => {
              recordMenu.insertRecord?.('after', num)
              closeRecordMenu()
            }}
            icon={<ArrowDown className={iconClassName} />}
          />
        ),
        onClick: () => {},
      },
    ],
    // Group 2: Add sub-record, Duplicate, Copy link
    [
      {
        key: 'add-sub-record',
        name: labels.addSubRecord,
        icon: <ListOrdered className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.insertSubRecord,
        onClick: () => {},
        render: (
          <div
            role="button"
            tabIndex={0}
            className="flex h-9 w-full items-center rounded-sm px-4 py-2 text-left text-body transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/40"
            onMouseDown={(event) => {
              stopOverlayPointerEvent(event)
              if (!isPrimaryMouseButton(event)) return
              closeRecordMenu()
              void recordMenu.insertSubRecord?.()
            }}
            onPointerDown={stopOverlayPointerEvent}
          >
            <ListOrdered className={iconClassName} />
            {labels.addSubRecord}
          </div>
        ),
      },
      {
        key: 'duplicate',
        name: labels.duplicate,
        icon: <Copy className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.duplicateRecord,
        onClick: async () => {
          await recordMenu.duplicateRecord?.()
        },
      },
      {
        key: 'copy-link',
        name: labels.copyLink,
        icon: <Copy className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.copyRecordUrl,
        onClick: async () => {
          await recordMenu.copyRecordUrl?.()
        },
      },
    ],
    // Group 3: Comment + View history + Send to chat
    [
      {
        key: 'comment',
        name: labels.comment,
        icon: <MessageSquare className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.commentRecord,
        onClick: () => {
          recordMenu.commentRecord?.()
        },
      },
      {
        key: 'view-history',
        name: labels.viewHistory,
        icon: <History className={iconClassName} />,
        hidden: isMultipleSelected || !recordMenu.viewRecordHistory,
        onClick: async () => {
          await recordMenu.viewRecordHistory?.()
        },
      },
      {
        key: 'send-to-chat',
        name: isMultipleSelected ? labels.sendMultipleToChat : labels.sendToChat,
        icon: <MessageSquare className={iconClassName} />,
        hidden: !recordMenu.sendToChat,
        onClick: () => {
          recordMenu.sendToChat?.()
        },
      },
    ],
    // Group 4: Delete
    [
      {
        key: 'delete',
        name: isMultipleSelected ? labels.deleteMultiple : labels.delete,
        icon: <Trash2 className={iconClassName} />,
        hidden: !recordMenu.deleteRecords,
        className: 'text-destructive aria-selected:text-destructive',
        onClick: async () => {
          await recordMenu.deleteRecords?.()
        },
      },
    ],
  ].map((items) => items.filter((item) => !item.hidden))

  if (menuItemGroups.every((g) => g.length === 0)) return null

  const executeItem = async (onClick: () => void | Promise<void>) => {
    await onClick()
    closeRecordMenu()
  }

  const menu = (
    <div
      ref={setRecordMenuRef}
      role="menu"
      data-grid-overlay="record-menu"
      className="z-modal min-w-40 rounded-md border bg-popover shadow-md"
      style={floatingStyles}
      onMouseDown={stopOverlayPointerEvent}
      onPointerDown={stopOverlayPointerEvent}
    >
      <OverlayMenuList className="max-h-96 overflow-y-auto">
        {menuItemGroups.map((items, index) => {
          const nextItems = menuItemGroups[index + 1] ?? []
          const hasNextItems = nextItems.length > 0
          if (!items.length) return null

          return (
            <Fragment key={index}>
              <OverlayMenuGroup>
                {items.map(({ key, name, icon, className, onClick, render }) => (
                  render ? (
                    <div key={key}>{render}</div>
                  ) : (
                    <OverlayMenuItem
                      className={className}
                      key={key}
                      onMouseDown={(event) => {
                        stopOverlayPointerEvent(event)
                        if (!isPrimaryMouseButton(event)) return
                        void executeItem(onClick)
                      }}
                    >
                      {icon}
                      {name}
                    </OverlayMenuItem>
                  )
                ))}
              </OverlayMenuGroup>
              {hasNextItems && <OverlayMenuSeparator />}
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
