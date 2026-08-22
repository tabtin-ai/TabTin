import { useEffect, useEffectEvent } from 'react'
import {
  TABDOC_FIND_REQUEST_EVENT,
  type TabDocFindRequestDetail,
} from '../docFindRequest'

export interface UseTabDocFindRequestOptions {
  documentId: string | null | undefined
  enabled: boolean
  onRequest: () => void
}

export function useTabDocFindRequest({
  documentId,
  enabled,
  onRequest,
}: UseTabDocFindRequestOptions): void {
  const handleFindRequest = useEffectEvent((event: Event) => {
    const detail = (event as CustomEvent<TabDocFindRequestDetail>).detail
    if (!enabled || !documentId || detail?.documentId !== documentId) return
    onRequest()
  })

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const listener = (event: Event) => handleFindRequest(event)
    window.addEventListener(TABDOC_FIND_REQUEST_EVENT, listener)
    return () => window.removeEventListener(TABDOC_FIND_REQUEST_EVENT, listener)
  }, [])
}
