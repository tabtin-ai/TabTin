import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

type SlotRegistry = Map<string, HTMLElement[]>

const EMPTY_UNLOADED_SET: ReadonlySet<string> = Object.freeze(new Set<string>())

interface TablePanePortalContextValue {
  slots: SlotRegistry
  registerSlot: (tableId: string, slot: HTMLElement) => void
  unregisterSlot: (tableId: string, slot: HTMLElement) => void
  parkingHost: HTMLElement | null
  setParkingHost: (host: HTMLElement | null) => void
  unloadedTableIds: ReadonlySet<string>
  setUnloadedTableIds: (ids: ReadonlySet<string>) => void
}

const TablePanePortalContext = createContext<TablePanePortalContextValue | null>(null)

export const TablePanePortalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [slots, setSlots] = useState<SlotRegistry>(() => new Map())
  const [parkingHost, setParkingHostState] = useState<HTMLElement | null>(null)
  const [unloadedTableIds, setUnloadedTableIdsState] = useState<ReadonlySet<string>>(EMPTY_UNLOADED_SET)

  const registerSlot = useCallback((tableId: string, slot: HTMLElement) => {
    setSlots(prev => {
      const current = prev.get(tableId) ?? []
      if (current.includes(slot)) {
        return prev
      }
      const next = new Map(prev)
      next.set(tableId, [...current, slot])
      return next
    })
  }, [])

  const unregisterSlot = useCallback((tableId: string, slot: HTMLElement) => {
    setSlots(prev => {
      const current = prev.get(tableId)
      if (!current || current.length === 0) {
        return prev
      }
      const nextList = current.filter(item => item !== slot)
      if (nextList.length === current.length) {
        return prev
      }
      const next = new Map(prev)
      if (nextList.length === 0) {
        next.delete(tableId)
      } else {
        next.set(tableId, nextList)
      }
      return next
    })
  }, [])

  const setParkingHost = useCallback((host: HTMLElement | null) => {
    setParkingHostState(prev => (prev === host ? prev : host))
  }, [])

  const setUnloadedTableIds = useCallback((ids: ReadonlySet<string>) => {
    setUnloadedTableIdsState(prev => (prev === ids ? prev : ids))
  }, [])

  const value = useMemo(
    () => ({
      slots,
      registerSlot,
      unregisterSlot,
      parkingHost,
      setParkingHost,
      unloadedTableIds,
      setUnloadedTableIds,
    }),
    [slots, parkingHost, unloadedTableIds]
  )

  return (
    <TablePanePortalContext.Provider value={value}>
      {children}
    </TablePanePortalContext.Provider>
  )
}

export const useTablePanePortal = (): TablePanePortalContextValue => {
  const context = useContext(TablePanePortalContext)
  if (!context) {
    throw new Error('[TablePanePortal] Missing provider')
  }
  return context
}
