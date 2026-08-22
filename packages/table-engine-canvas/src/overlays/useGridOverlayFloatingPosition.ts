import { autoUpdate, flip, offset, shift, useFloating, type Placement } from '@floating-ui/react'
import { useEffect, useMemo, type CSSProperties, type RefObject } from 'react'
import type { IPosition, IRectangle } from '../grid/interface'

export const GRID_OVERLAY_MENU_GAP = 4
export const GRID_OVERLAY_STATISTIC_MENU_GAP = 6
export const GRID_OVERLAY_VIEWPORT_PADDING = 8

const FALLBACK_ANCHOR_SIZE = 1

export type GridOverlayAnchorRect = IPosition & Partial<Pick<IRectangle, 'width' | 'height'>>

export const resolveOverlayAnchorRect = (
  anchor: GridOverlayAnchorRect,
  containerRect?: DOMRect | null,
): DOMRect => {
  const useClientSpace = anchor.coordinateSpace === 'client'
  const originX = useClientSpace ? 0 : containerRect?.left ?? 0
  const originY = useClientSpace ? 0 : containerRect?.top ?? 0
  const width = anchor.width ?? FALLBACK_ANCHOR_SIZE
  const height = anchor.height ?? FALLBACK_ANCHOR_SIZE

  return new DOMRect(originX + anchor.x, originY + anchor.y, width, height)
}

interface GridOverlayFloatingOptions {
  open: boolean
  anchor?: GridOverlayAnchorRect | null
  anchorRef?: RefObject<HTMLElement | null>
  placement?: Placement
  gap?: number
  onAnchorUnavailable?: () => void
}

interface GridOverlayFloatingResult {
  setFloatingRef: (node: HTMLElement | null) => void
  floatingStyles: CSSProperties
}

export const isGridOverlayAnchorVisible = (element: HTMLElement | null | undefined) => {
  if (!element?.isConnected) return false
  return element.getClientRects().length > 0
}

export function useGridOverlayFloatingPosition({
  open,
  anchor,
  anchorRef,
  placement = 'bottom-start',
  gap = GRID_OVERLAY_MENU_GAP,
  onAnchorUnavailable,
}: GridOverlayFloatingOptions): GridOverlayFloatingResult {
  const virtualReference = useMemo(() => {
    if (!open || !anchor) return null

    const contextElement = anchorRef?.current ?? undefined

    return {
      contextElement,
      getBoundingClientRect: () =>
        resolveOverlayAnchorRect(anchor, anchorRef?.current?.getBoundingClientRect()),
    }
  }, [anchor, anchorRef, open])

  const { refs, floatingStyles } = useFloating({
    open,
    placement,
    strategy: 'fixed',
    middleware: [
      offset(gap),
      flip({ padding: GRID_OVERLAY_VIEWPORT_PADDING }),
      shift({ padding: GRID_OVERLAY_VIEWPORT_PADDING }),
    ],
    whileElementsMounted: autoUpdate,
  })

  useEffect(() => {
    if (!open) {
      refs.setReference(null)
      return
    }

    const anchorElement = anchorRef?.current
    if (anchorRef && !isGridOverlayAnchorVisible(anchorElement)) {
      onAnchorUnavailable?.()
      refs.setReference(null)
      return
    }

    refs.setReference(virtualReference)
    return () => refs.setReference(null)
  }, [anchorRef, onAnchorUnavailable, open, refs, virtualReference])

  const resolvedFloatingStyles = useMemo<CSSProperties>(
    () => ({
      ...floatingStyles,
      visibility: virtualReference ? 'visible' : 'hidden',
    }),
    [floatingStyles, virtualReference],
  )

  return {
    setFloatingRef: refs.setFloating,
    floatingStyles: resolvedFloatingStyles,
  }
}
