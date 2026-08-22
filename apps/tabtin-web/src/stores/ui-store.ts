import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'

export type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

interface UIState {
  theme: ThemePreference
  resolvedTheme: ResolvedTheme
}

interface UIActions {
  setTheme: (theme: ThemePreference) => void
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? getSystemTheme() : preference
}

function applyTheme(resolved: ResolvedTheme) {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
}

export const useUIStore = create<UIState & UIActions>()(
  persist(
    (set) => ({
      theme: 'system',
      resolvedTheme: getSystemTheme(),

      setTheme: (theme) => {
        const resolved = resolveTheme(theme)
        applyTheme(resolved)
        set({ theme, resolvedTheme: resolved })
      },
    }),
    withPersistSafety({
      name: 'tabtin-ui-store',
      partialize: (state) => ({ theme: state.theme }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const resolved = resolveTheme(state.theme)
        applyTheme(resolved)
        queueMicrotask(() => {
          useUIStore.setState({ resolvedTheme: resolved })
        })
      },
    }),
  ),
)

if (typeof window !== 'undefined') {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', () => {
    const { theme } = useUIStore.getState()
    if (theme === 'system') {
      const resolved = getSystemTheme()
      applyTheme(resolved)
      useUIStore.setState({ resolvedTheme: resolved })
    }
  })
}
