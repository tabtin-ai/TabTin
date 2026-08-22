import { createContext, useContext } from 'react'
import type { TabDocEditorConfig } from './ports'

const TabDocEditorConfigContext = createContext<TabDocEditorConfig | null>(null)

export const TabDocEditorConfigProvider = TabDocEditorConfigContext.Provider

export function useTabDocEditorConfig(): TabDocEditorConfig {
  const config = useContext(TabDocEditorConfigContext)
  if (!config) {
    throw new Error(
      '[useTabDocEditorConfig] TabDocEditorConfig not found in context. ' +
        'Ensure TabDocEditorConfigProvider wraps this component tree.',
    )
  }
  return config
}

export function useTabDocEditorConfigOptional(): TabDocEditorConfig | null {
  return useContext(TabDocEditorConfigContext)
}
