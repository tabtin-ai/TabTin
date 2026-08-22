import { create } from 'zustand'
import type { ExternalArchiveFocus } from './externalArchiveTypes'

interface ExternalArchiveFocusState {
  focus: ExternalArchiveFocus | null
  setFocus: (focus: ExternalArchiveFocus | null) => void
  consumeFocus: () => ExternalArchiveFocus | null
}

export const useExternalArchiveFocusStore = create<ExternalArchiveFocusState>((set, get) => ({
  focus: null,
  setFocus: (focus) => set({ focus }),
  consumeFocus: () => {
    const { focus } = get()
    if (focus) set({ focus: null })
    return focus
  },
}))
