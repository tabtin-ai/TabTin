import type { StateCreator } from 'zustand'
import type { PPTElement } from '../../types/slides'

export interface ClipboardStoreState {
  items: PPTElement[]
  pasteOffset: number
  isCutting: boolean
  setItems: (items: PPTElement[], cutting?: boolean) => void
  incrementPasteOffset: (amount: number) => void
  resetPasteOffset: () => void
  setNotCutting: () => void
  clear: () => void
}

export type ClipboardStoreSet = Parameters<StateCreator<ClipboardStoreState>>[0]
export type ClipboardStoreGet = () => ClipboardStoreState
