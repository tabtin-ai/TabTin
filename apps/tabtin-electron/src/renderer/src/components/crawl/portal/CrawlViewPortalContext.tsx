import React, { createContext, useCallback, useContext, useMemo, useState } from 'react'

export type CrawlViewSlotSource = 'workspace' | 'canvas' | 'unknown'

export interface CrawlViewSlotEntry {
  element: HTMLElement
  isActive: boolean
  priority: number
  source: CrawlViewSlotSource
}

type SlotRegistry = Map<string, Map<HTMLElement, CrawlViewSlotEntry>>

interface CrawlViewPortalContextValue {
  slots: SlotRegistry
  registerSlot: (viewId: string, entry: CrawlViewSlotEntry) => void
  unregisterSlot: (viewId: string, element: HTMLElement) => void
  parkingHost: HTMLElement | null
  setParkingHost: (host: HTMLElement | null) => void
}

const CrawlViewPortalContext = createContext<CrawlViewPortalContextValue | null>(null)

export const CrawlViewPortalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [slots, setSlots] = useState<SlotRegistry>(() => new Map())
  const [parkingHost, setParkingHostState] = useState<HTMLElement | null>(null)

  const registerSlot = useCallback((viewId: string, entry: CrawlViewSlotEntry) => {
    setSlots(prev => {
      const current = prev.get(viewId)
      const currentEntry = current?.get(entry.element)
      if (
        currentEntry &&
        currentEntry.isActive === entry.isActive &&
        currentEntry.priority === entry.priority &&
        currentEntry.source === entry.source
      ) {
        return prev
      }
      const next = new Map(prev)
      const nextMap = new Map(current ?? [])
      nextMap.set(entry.element, entry)
      next.set(viewId, nextMap)
      return next
    })
  }, [])

  const unregisterSlot = useCallback((viewId: string, element: HTMLElement) => {
    setSlots(prev => {
      const current = prev.get(viewId)
      if (!current || !current.has(element)) {
        return prev
      }
      const next = new Map(prev)
      const nextMap = new Map(current)
      nextMap.delete(element)
      if (nextMap.size === 0) {
        next.delete(viewId)
      } else {
        next.set(viewId, nextMap)
      }
      return next
    })
  }, [])

  const setParkingHost = useCallback((host: HTMLElement | null) => {
    setParkingHostState(prev => (prev === host ? prev : host))
  }, [])

  const value = useMemo(
    () => ({
      slots,
      registerSlot,
      unregisterSlot,
      parkingHost,
      setParkingHost
    }),
    [slots, registerSlot, unregisterSlot, parkingHost, setParkingHost]
  )

  return (
    <CrawlViewPortalContext.Provider value={value}>
      {children}
    </CrawlViewPortalContext.Provider>
  )
}

export const useCrawlViewPortal = (): CrawlViewPortalContextValue => {
  const context = useContext(CrawlViewPortalContext)
  if (!context) {
    throw new Error('[CrawlViewPortal] Missing provider')
  }
  return context
}
