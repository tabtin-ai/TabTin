import { createContext, useContext } from 'react'
import type { TabDocHostActions } from '@tabtin/app-host-sdk'

const TabDocHostActionsContext = createContext<TabDocHostActions | null>(null)

export const TabDocHostActionsProvider = TabDocHostActionsContext.Provider

export function useTabDocHostActions(): TabDocHostActions {
  const actions = useContext(TabDocHostActionsContext)
  if (!actions) {
    throw new Error(
      '[useTabDocHostActions] TabDocHostActions not found in context. ' +
        'Ensure TabDocHostActionsProvider wraps this component tree.',
    )
  }
  return actions
}

export function useTabDocHostActionsOptional(): TabDocHostActions | null {
  return useContext(TabDocHostActionsContext)
}
