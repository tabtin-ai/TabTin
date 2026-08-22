import { useEffect } from 'react'

export type TableDrawerKind = 'field-settings' | 'record-form' | 'record-history'

const TABLE_DRAWER_OPEN_EVENT = 'tabtin:table-drawer-open'

type TableDrawerOpenDetail = {
  kind: TableDrawerKind
  sourceId: string
}

export function announceTableDrawerOpen(kind: TableDrawerKind, sourceId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<TableDrawerOpenDetail>(TABLE_DRAWER_OPEN_EVENT, {
      detail: { kind, sourceId },
    }),
  )
}

export function useCloseOnOtherTableDrawerOpen(
  kind: TableDrawerKind,
  sourceId: string,
  isOpen: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return

    const handleDrawerOpen = (event: Event) => {
      const detail = (event as CustomEvent<TableDrawerOpenDetail>).detail
      if (detail?.kind && detail.sourceId !== sourceId) {
        onClose()
      }
    }

    window.addEventListener(TABLE_DRAWER_OPEN_EVENT, handleDrawerOpen)
    return () => {
      window.removeEventListener(TABLE_DRAWER_OPEN_EVENT, handleDrawerOpen)
    }
  }, [isOpen, kind, onClose, sourceId])
}
