export const GRID_SEARCH_INPUT_ATTR = 'data-t-grid-search-input'
export const GRID_SEARCH_INPUT_VALUE = 'true'
export const GRID_SEARCH_INPUT_SELECTOR = `[${GRID_SEARCH_INPUT_ATTR}="${GRID_SEARCH_INPUT_VALUE}"]`
export const GRID_SEARCH_REQUEST_EVENT = 'tabtin:grid-search-request'

export interface GridSearchRequestDetail {
  tableId: string
}

export function requestGridSearch(tableId: string): void {
  if (!tableId || typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<GridSearchRequestDetail>(GRID_SEARCH_REQUEST_EVENT, {
    detail: { tableId },
  }))
}

export function isGridSearchInputFocused(activeElement?: Element | null): boolean {
  if (activeElement === undefined && typeof document === 'undefined') return false

  const target = activeElement ?? document.activeElement
  if (!target || typeof target.closest !== 'function') return false

  return Boolean(target.closest(GRID_SEARCH_INPUT_SELECTOR))
}

export function shouldActivateGridForSearchMatch(activeElement?: Element | null): boolean {
  return !isGridSearchInputFocused(activeElement)
}
