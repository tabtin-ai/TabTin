import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import { createClipboardSlice } from './action'
import { initialClipboardStoreState } from './initial-state'
import type { ClipboardStoreState } from './clipboard-store-types'

export type {
  ClipboardStoreGet,
  ClipboardStoreSet,
  ClipboardStoreState,
} from './clipboard-store-types'

const createClipboardStore: StateCreator<ClipboardStoreState> = (...params) => ({
  ...initialClipboardStoreState,
  ...createClipboardSlice(...params),
})

export const useClipboardStore = create<ClipboardStoreState>(createClipboardStore)
