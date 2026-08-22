import { create } from 'zustand'
import type { ContextItemRecord } from './contextTabs/types'

export interface AppCollaborationRequest {
  sourceLabel: string
  prompt: string
  preferredSpaceId: string
  contextBlocks?: Array<Record<string, unknown>>
  sourceItem?: ContextItemRecord | null
}

interface AppCollaborationState {
  request: AppCollaborationRequest | null
  open: (request: AppCollaborationRequest) => void
  close: () => void
}

export const useAppCollaborationStore = create<AppCollaborationState>((set) => ({
  request: null,
  open: request => set({ request }),
  close: () => set({ request: null }),
}))
