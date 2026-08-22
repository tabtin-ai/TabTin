import { useEffect, useMemo, useRef, useState } from 'react'
import {
  CollabStatus,
  getUserColor,
  shouldFallbackToLegacy,
  useAwarenessStates,
  useCollabProvider,
  type CollabProviderOptions,
} from '@tabtin/collab-core'
import {
  SLIDE_COLLAB_ENABLED,
  SLIDE_COLLAB_WS_URL,
} from '../collab/slide-collab-config'
import type { UseSlideCollaborationInput } from './useSlideCollaborationTypes'

export function useSlideCollabConnection(
  input: UseSlideCollaborationInput,
  userLabel: string,
) {
  const [token, setToken] = useState<string>('')
  const enabled = SLIDE_COLLAB_ENABLED && (input.enabled !== false)
  const getTokenRef = useRef(input.getToken)
  getTokenRef.current = input.getToken

  useEffect(() => {
    if (!enabled || !input.projectId) return
    const result = getTokenRef.current()
    if (result instanceof Promise) {
      result.then(setToken).catch(() => setToken(''))
    } else {
      setToken(result)
    }
  }, [enabled, input.projectId])

  const resolvedUserName = input.user?.name || (userLabel === 'label.user' ? 'User' : userLabel)
  const collabOptions = useMemo<CollabProviderOptions | null>(() => {
    if (!enabled || !input.projectId || !token) return null
    const userId = input.user?.id || 'anonymous'

    return {
      serverUrl: input.serverUrl || SLIDE_COLLAB_WS_URL,
      documentName: `slide:${input.projectId}`,
      token,
      user: {
        id: userId,
        name: resolvedUserName,
        color: getUserColor(userId),
        type: 'user',
      },
      enableIndexedDB: true,
    }
  }, [enabled, input.projectId, token, input.user?.id, resolvedUserName, input.serverUrl])

  const collab = useCollabProvider(collabOptions)
  const awarenessPeers = useAwarenessStates(collab.provider)
  const isFallback = useMemo(() => {
    if (!enabled) return true
    if (!collabOptions) return true
    return shouldFallbackToLegacy(collab.status, collab.forceCloseMessage?.code, collab.disconnectTimedOut)
  }, [enabled, collabOptions, collab.status, collab.forceCloseMessage, collab.disconnectTimedOut])

  const isOnline = collab.status === CollabStatus.SYNCED || collab.status === CollabStatus.SYNCING
  const isHttpFallback = !isFallback && !isOnline

  return {
    enabled,
    collab,
    collabOptions,
    awarenessPeers,
    isFallback,
    isOnline,
    isHttpFallback,
  }
}
