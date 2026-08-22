const VIEW_ACTION_ICON_GROUP_WIDTH = 220
const SEARCH_BUTTON_WIDTH = 30
const SEARCH_EXPANDED_WIDTH = 380
const MORE_MENU_WIDTH = 38
const RIGHT_ACTION_BUTTON_WIDTH = 32
const RIGHT_ACTION_GAP = 4
const RIGHT_ACTION_RESERVED_GAP = 24

export function calculateVisibleRightActionCount(
  width: number,
  presentActionCount: number,
  searchExpanded = false,
): number {
  const searchWidth = searchExpanded ? SEARCH_EXPANDED_WIDTH : SEARCH_BUTTON_WIDTH
  const budget =
    width -
    VIEW_ACTION_ICON_GROUP_WIDTH -
    searchWidth -
    MORE_MENU_WIDTH -
    RIGHT_ACTION_RESERVED_GAP

  return Math.max(
    0,
    Math.min(
      presentActionCount,
      Math.floor((budget + RIGHT_ACTION_GAP) / (RIGHT_ACTION_BUTTON_WIDTH + RIGHT_ACTION_GAP)),
    ),
  )
}
