export type MobileDocMode = 'reading' | 'editing'

export interface MobileDocAccessInput {
  compact: boolean
  canEdit: boolean
  requestedMode: MobileDocMode
}

export interface MobileDocAccess {
  mode: MobileDocMode
  readOnly: boolean
  canEnterEditMode: boolean
}

export function resolveMobileDocAccess({
  compact,
  canEdit,
  requestedMode,
}: MobileDocAccessInput): MobileDocAccess {
  if (!compact) {
    return {
      mode: canEdit ? 'editing' : 'reading',
      readOnly: !canEdit,
      canEnterEditMode: canEdit,
    }
  }

  if (!canEdit) {
    return {
      mode: 'reading',
      readOnly: true,
      canEnterEditMode: false,
    }
  }

  return {
    mode: requestedMode,
    readOnly: requestedMode !== 'editing',
    canEnterEditMode: true,
  }
}

interface MobileVisualViewport {
  viewportOffsetTop: number
  viewportHeight: number
  containerTop: number
}

export function resolveMobileEditorAvailableHeight({
  viewportOffsetTop,
  viewportHeight,
  containerTop,
}: MobileVisualViewport): number | null {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return null

  const safeOffsetTop = Number.isFinite(viewportOffsetTop) ? viewportOffsetTop : 0
  const safeContainerTop = Number.isFinite(containerTop) ? containerTop : safeOffsetTop
  const visibleTop = Math.max(safeOffsetTop, safeContainerTop)
  const visibleBottom = safeOffsetTop + viewportHeight

  return Math.max(0, Math.round(visibleBottom - visibleTop))
}
