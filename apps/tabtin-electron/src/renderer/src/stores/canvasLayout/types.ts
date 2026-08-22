import type { LayoutNode, SplitDirection } from '@/utils/split-layout'

export type CanvasTabKey = `${string}:${string}`

export type CanvasPaneContent = {
  tabKey: CanvasTabKey
}

export type CanvasLayoutDirection = SplitDirection

export type CanvasLayoutNode = LayoutNode

export interface CanvasPane {
  id: string
  content: CanvasPaneContent | null
}

export interface CanvasLayoutGroup {
  id: string
  spaceId: string
  anchorTabKey: CanvasTabKey
  panes: CanvasPane[]
  layout: CanvasLayoutNode
  activePaneId: string | null
  createdAt: number
  updatedAt: number
}
