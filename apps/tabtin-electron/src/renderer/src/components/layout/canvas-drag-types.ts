import type { RefObject } from 'react'
import type { CanvasLayoutGroup, CanvasPaneContent, CanvasTabKey } from '@stores/useCanvasLayoutStore'

export type DragType = 'tab' | 'pane'

export type PaneDragPayload = {
  paneId: string
  groupId: string
}

export type PaneRect = {
  paneId: string
  groupId: string
  rect: DOMRect
}

export type DropSide = 'left' | 'right' | 'top' | 'bottom'

export type DropIntent =
  | {
      kind: 'assign'
      groupId: string
      paneId: string
      rect: DOMRect
    }
  | {
      kind: 'split'
      groupId: string
      paneId: string
      side: DropSide
      rect: DOMRect
    }
  | {
      kind: 'move'
      groupId: string
      sourcePaneId: string
      targetPaneId: string
      side: DropSide
      rect: DOMRect
    }
  | {
      kind: 'dock'
      groupId: string
      paneId: string
      side: DropSide
      rect: DOMRect
    }
  | {
      kind: 'create-group'
      side: DropSide
      rect: DOMRect
    }

export type SqueezeIntent =
  | {
      kind: 'pane'
      paneId: string
      side: DropSide
    }
  | {
      kind: 'multi-pane'
      paneIds: string[]
      side: DropSide
    }
  | {
      kind: 'group'
      groupId: string
      side: DropSide
    }
  | {
      kind: 'content'
      side: DropSide
    }

export type DebugRect = {
  id: string
  label: string
  color: string
  rect: { left: number; top: number; width: number; height: number }
  dashed?: boolean
}

export type DebugPoint = { x: number; y: number }

export type CreateGroupBlockReason = 'home' | 'self' | 'grouped' | 'unavailable'

export type TabDropBlockReason =
  | CreateGroupBlockReason
  | 'outside'
  | 'duplicate'
  | 'group-full'
  | 'move-to-edge'

export type TabDropEvaluation = {
  intent: DropIntent | null
  blockReason: TabDropBlockReason | null
}

export interface CanvasDragLayerProps {
  spaceId: string
  contentRootRef: RefObject<HTMLElement | null>
  activeTabKey: CanvasTabKey | null
  isHomeActive: boolean
  spaceGroups: CanvasLayoutGroup[]
  shouldShowCanvasGroup: boolean
  buildContentFromActiveTab: () => CanvasPaneContent | null
  buildContentFromDrag: (tabKey: string, metaRaw: string) => CanvasPaneContent | null
}

export const CONTENT_MARGIN = 12
export const CANVAS_DROP_ACTIVATION_INSET = 8
export const EDGE_ENTER_MIN = 40
export const EDGE_ENTER_MAX = 96
export const EDGE_EXIT_PADDING = 16
export const EDGE_SQUEEZE_SIZE = 30
