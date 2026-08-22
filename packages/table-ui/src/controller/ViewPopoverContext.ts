/**
 * ViewPopoverContext — typed React Context for opening view config popovers.
 *
 * Replaces global CustomEvent-based communication between TablePaneView
 * and WebViewFilterGroupBar. Type-safe, testable, no global namespace pollution.
 */

import { createContext, useContext } from 'react'

export interface ViewPopoverControls {
  openSortPopover: (fieldId?: string) => void
  openFilterPopover: (fieldId?: string) => void
  openGroupPopover: (fieldId?: string) => void
}

const ViewPopoverContext = createContext<ViewPopoverControls | null>(null)

export const useViewPopoverControls = (): ViewPopoverControls | null =>
  useContext(ViewPopoverContext)

export const ViewPopoverProvider = ViewPopoverContext.Provider
