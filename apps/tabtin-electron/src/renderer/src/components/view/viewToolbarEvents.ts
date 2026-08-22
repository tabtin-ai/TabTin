export const OPEN_VIEW_SORT_POPOVER_EVENT = 'tabtin:view-sort-popover-open'
export const OPEN_VIEW_FILTER_POPOVER_EVENT = 'tabtin:view-filter-popover-open'

export interface OpenViewSortPopoverEventDetail {
  viewId?: string | null
  fieldId?: string | null
}

export interface OpenViewFilterPopoverEventDetail {
  viewId?: string | null
  fieldId?: string | null
}

export const dispatchOpenViewSortPopover = (
  detail: OpenViewSortPopoverEventDetail,
) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<OpenViewSortPopoverEventDetail>(
      OPEN_VIEW_SORT_POPOVER_EVENT,
      { detail },
    ),
  )
}

export const dispatchOpenViewFilterPopover = (
  detail: OpenViewFilterPopoverEventDetail,
) => {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<OpenViewFilterPopoverEventDetail>(
      OPEN_VIEW_FILTER_POPOVER_EVENT,
      { detail },
    ),
  )
}
