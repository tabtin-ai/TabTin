export type ThemeMode = 'light' | 'dark' | 'system'

export interface LayoutState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  listWidth: number
  pinnedWidth: number
  contextCollapsed?: boolean
  chatSidePanelWidth: number
  chatSidePanelCollapsed: boolean
}

export interface LoadingState {
  isLoading: boolean
  error: string | null
}
