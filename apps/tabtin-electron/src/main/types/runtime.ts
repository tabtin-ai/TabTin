export type MainWindowAppearance = 'light' | 'dark' | 'system'

export {
  CONTEXT_SPACE_NUMERIC_TAB_ACTIONS,
  getNumericTabAction,
  isContextSpaceSwitchTabAction,
  resolveSwitchTabIndex,
} from '../../shared/context-space-shortcuts'
export type {
  ContextSpaceNumericTabKey,
  ContextSpaceShortcutAction,
  ContextSpaceShortcutSwitchTabAction,
} from '../../shared/context-space-shortcuts'

export interface ContextSpaceShortcutGuardOptions {
  interceptZoomShortcuts?: boolean
}
