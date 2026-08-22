/**
 * StatisticMenu
 *
 * Column statistics function selector.
 */
import React, { useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { RefObject } from 'react'
import { useClickAway } from 'react-use'
import {
  OverlayMenuGroup,
  OverlayMenuItem,
  OverlayMenuList,
} from './menuPrimitives'
import { useGridOverlayStore } from './store'
import { defaultStatLabels, getValidStatFuncs, StatFunc } from './statistics'
import {
  GRID_OVERLAY_STATISTIC_MENU_GAP,
  useGridOverlayFloatingPosition,
} from './useGridOverlayFloatingPosition'

// ---------------------------------------------------------------------------
// StatisticMenu component
// ---------------------------------------------------------------------------

export const StatisticMenu: React.FC<{
  labels?: Record<string, string>
  onSelect?: (field: string, func: StatFunc) => void
  anchorRef?: RefObject<HTMLElement | null>
  ownerId?: string
}> = ({ labels: _labels, onSelect, anchorRef, ownerId }) => {
  const statLabels = { ...defaultStatLabels, ..._labels }
  const { statisticMenu, closeStatisticMenu } = useGridOverlayStore()
  const fieldStatisticRef = useRef<HTMLDivElement>(null)

  const closeOwnedStatisticMenu = useCallback(() => {
    const currentStatisticMenu = useGridOverlayStore.getState().statisticMenu
    if (
      !currentStatisticMenu?.ownerId ||
      !ownerId ||
      currentStatisticMenu.ownerId === ownerId
    ) {
      closeStatisticMenu()
    }
  }, [closeStatisticMenu, ownerId])

  useClickAway(fieldStatisticRef, closeOwnedStatisticMenu)
  const field = statisticMenu?.field ?? ''
  const fieldType = statisticMenu?.fieldType ?? 'text'
  const position = statisticMenu?.position
  const isOwner =
    !statisticMenu?.ownerId ||
    !ownerId ||
    statisticMenu.ownerId === ownerId

  const handleAnchorUnavailable = useCallback(() => {
    closeOwnedStatisticMenu()
  }, [closeOwnedStatisticMenu])

  const { setFloatingRef, floatingStyles } = useGridOverlayFloatingPosition({
    open: Boolean(statisticMenu && isOwner),
    anchor: position,
    anchorRef,
    placement: 'top-start',
    gap: GRID_OVERLAY_STATISTIC_MENU_GAP,
    onAnchorUnavailable: handleAnchorUnavailable,
  })

  const setStatisticMenuRef = useCallback((node: HTMLDivElement | null) => {
    fieldStatisticRef.current = node
    setFloatingRef(node)
  }, [setFloatingRef])

  if (!statisticMenu) return null
  if (!isOwner) return null

  const menuItems: (StatFunc.None | StatFunc)[] = [
    StatFunc.None as StatFunc.None,
    ...getValidStatFuncs(fieldType),
  ]

  const handleSelect = (func: StatFunc.None | StatFunc) => {
    closeStatisticMenu()
    onSelect?.(field, func as StatFunc)
  }

  const menu = (
    <div
      ref={setStatisticMenuRef}
      role="menu"
      data-grid-overlay="statistic-menu"
      data-grid-overlay-owner={statisticMenu.ownerId}
      className="z-modal w-[150px] rounded-sm border bg-popover px-0 py-1 shadow-md"
      style={floatingStyles}
      onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
    >
      <OverlayMenuList>
        <OverlayMenuGroup className="px-0">
          {menuItems.map((func) => (
            <OverlayMenuItem
              className="rounded-none px-2 py-1.5"
              key={func}
              onClick={() => handleSelect(func)}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {statLabels[func] ?? func}
            </OverlayMenuItem>
          ))}
        </OverlayMenuGroup>
      </OverlayMenuList>
    </div>
  )

  if (typeof document === 'undefined') {
    return menu
  }

  return createPortal(menu, document.body)
}
