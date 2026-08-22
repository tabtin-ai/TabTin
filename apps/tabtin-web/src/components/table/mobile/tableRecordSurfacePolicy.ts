import type {
  WebLayout,
  WebOrientation,
} from '@/components/layout/WebPresentationEnvironment'

export type TableRecordSurface = 'cards' | 'grid'
export type TableRecordSurfacePreference = TableRecordSurface | null

export interface TableRecordSurfaceSelection {
  viewId: string | null
  byLayout: Partial<Record<WebLayout, TableRecordSurface>>
}

export interface TableRecordSurfacePolicyInput {
  isGridView: boolean
  isPhonePresentation: boolean
  isTabletPresentation: boolean
  layout: WebLayout
  orientation: WebOrientation
  preference: TableRecordSurfacePreference
}

export interface TableRecordSurfacePolicy {
  surface: TableRecordSurface
  showSwitcher: boolean
}

export function resolveTableRecordSurfacePreference(
  selection: TableRecordSurfaceSelection | null,
  viewId: string | null,
  layout: WebLayout,
): TableRecordSurfacePreference {
  return selection?.viewId === viewId ? selection.byLayout[layout] ?? null : null
}

export function selectTableRecordSurface(
  selection: TableRecordSurfaceSelection | null,
  viewId: string | null,
  layout: WebLayout,
  surface: TableRecordSurface,
): TableRecordSurfaceSelection {
  return {
    viewId,
    byLayout: {
      ...(selection?.viewId === viewId ? selection.byLayout : {}),
      [layout]: surface,
    },
  }
}

export function resolveTableRecordSurfacePolicy({
  isGridView,
  isPhonePresentation,
  isTabletPresentation,
  layout,
  orientation,
  preference,
}: TableRecordSurfacePolicyInput): TableRecordSurfacePolicy {
  const isAdaptiveRecordSurface = isGridView && (isPhonePresentation || isTabletPresentation)
  if (!isAdaptiveRecordSurface) {
    return { surface: 'grid', showSwitcher: false }
  }

  const tabletPrefersCards = isTabletPresentation && (
    orientation === 'portrait'
    || (orientation === 'unknown' && layout !== 'expanded')
  )
  const defaultSurface: TableRecordSurface = isPhonePresentation || tabletPrefersCards
    ? 'cards'
    : 'grid'

  return {
    surface: preference ?? defaultSurface,
    showSwitcher: true,
  }
}
