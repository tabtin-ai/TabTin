import { create } from 'zustand'

export interface SharedSessionAccessDescriptor {
  shareId: string
  sessionId: string
  organizationId?: string | null
  workspaceId?: string | null
  workspaceName?: string
  ownerUserId?: string
  ownerDisplayName?: string
  role?: 'owner' | 'grantee'
  /** v2 授权版本只用于丢弃迟到的撤权事件，不参与权限判定。 */
  version?: number
  accessEpoch?: number
}

interface SessionAccessState {
  bySessionId: Record<string, SharedSessionAccessDescriptor>
  setSharedAccess: (descriptor: SharedSessionAccessDescriptor) => void
  clearSharedAccess: (sessionId: string) => void
}

export const useSessionAccessStore = create<SessionAccessState>((set) => ({
  bySessionId: {},
  setSharedAccess: (descriptor) => set(state => ({
    bySessionId: {
      ...state.bySessionId,
      [descriptor.sessionId]: descriptor,
    },
  })),
  clearSharedAccess: (sessionId) => set(state => {
    if (!(sessionId in state.bySessionId)) return state
    const bySessionId = { ...state.bySessionId }
    delete bySessionId[sessionId]
    return { bySessionId }
  }),
}))
