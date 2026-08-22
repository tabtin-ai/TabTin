type NavigationEntryForState = {
  url?: string | null
}

export type NavigationHistoryForState = {
  canGoBack: () => boolean
  canGoForward: () => boolean
  getActiveIndex: () => number
  getAllEntries: () => NavigationEntryForState[]
}

export function isInternalHistoryUrl(url: string | null | undefined): boolean {
  return !url || url === 'about:blank' || url === 'about:srcdoc' || url.startsWith('chrome-error://')
}

function getUserHistoryPosition(history: NavigationHistoryForState): {
  activeIndex: number
  firstUserIndex: number
  previousUrl: string | null
} | null {
  if (!history.canGoBack()) return null

  try {
    const activeIndex = history.getActiveIndex()
    const entries = history.getAllEntries()
    const firstUserIndex = entries.findIndex(entry => !isInternalHistoryUrl(entry.url))
    if (activeIndex <= 0 || firstUserIndex < 0) return null
    const previousEntry = entries[activeIndex - 1]
    return {
      activeIndex,
      firstUserIndex,
      previousUrl: typeof previousEntry?.url === 'string' ? previousEntry.url : null,
    }
  } catch {
    return null
  }
}

export function canGoBackToUserPage(history: NavigationHistoryForState): boolean {
  const position = getUserHistoryPosition(history)
  if (!position) return false
  if (position.activeIndex <= position.firstUserIndex) return false
  if (isInternalHistoryUrl(position.previousUrl)) return false
  return true
}

export function getEffectiveNavigationState(webContents: { navigationHistory: NavigationHistoryForState }): {
  canGoBack: boolean
  canGoForward: boolean
} {
  const { navigationHistory } = webContents
  return {
    canGoBack: canGoBackToUserPage(navigationHistory),
    canGoForward: navigationHistory.canGoForward(),
  }
}
