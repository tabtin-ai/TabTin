export const TABDOC_FIND_REQUEST_EVENT = 'tabtin:tabdoc-find-request'

export interface TabDocFindRequestDetail {
  documentId: string
}

export function requestTabDocFind(documentId: string): void {
  if (!documentId || typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<TabDocFindRequestDetail>(TABDOC_FIND_REQUEST_EVENT, {
    detail: { documentId },
  }))
}
