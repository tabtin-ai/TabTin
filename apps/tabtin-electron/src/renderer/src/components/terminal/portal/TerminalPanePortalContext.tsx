import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

type SlotRegistry = Map<string, HTMLElement>

/* ------------------------------------------------------------------ */
/*  Stable context – 包含不会变化引用的函数，消费者不会因 slot 变动 re-render  */
/* ------------------------------------------------------------------ */

interface TerminalPanePortalStableValue {
  registerSlot: (sessionId: string, slot: HTMLElement) => void
  unregisterSlot: (sessionId: string, slot: HTMLElement) => void
  /** 获取 slots Map 的快照引用（ref.current），不触发 re-render */
  getSlotsRef: () => SlotRegistry
  setParkingHost: (host: HTMLElement | null) => void
}

/* ------------------------------------------------------------------ */
/*  Data context – 包含会变化的数据，只有真正需要响应 slot 变化的消费者订阅    */
/* ------------------------------------------------------------------ */

interface TerminalPanePortalDataValue {
  /** 递增版本号，每次 slots 变化 +1，用于触发依赖 slots 的消费者 re-render */
  slotsVersion: number
  parkingHost: HTMLElement | null
}

/* ------------------------------------------------------------------ */
/*  兼容接口 – 对外暴露的 hook 返回类型保持不变                              */
/* ------------------------------------------------------------------ */

interface TerminalPanePortalContextValue {
  slots: SlotRegistry
  /** 递增版本号，每次 slots 变化 +1，可用于 useEffect 依赖数组 */
  slotsVersion: number
  registerSlot: (sessionId: string, slot: HTMLElement) => void
  unregisterSlot: (sessionId: string, slot: HTMLElement) => void
  parkingHost: HTMLElement | null
  setParkingHost: (host: HTMLElement | null) => void
}

const StableContext = createContext<TerminalPanePortalStableValue | null>(null)
const DataContext = createContext<TerminalPanePortalDataValue | null>(null)

export const TerminalPanePortalProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const slotsRef = useRef<SlotRegistry>(new Map())
  const [slotsVersion, setSlotsVersion] = useState(0)
  const [parkingHost, setParkingHostState] = useState<HTMLElement | null>(null)

  const registerSlot = useCallback((sessionId: string, slot: HTMLElement) => {
    const current = slotsRef.current.get(sessionId) ?? null
    if (current === slot) return
    slotsRef.current.set(sessionId, slot)
    setSlotsVersion(v => v + 1)
  }, [])

  const unregisterSlot = useCallback((sessionId: string, slot: HTMLElement) => {
    const current = slotsRef.current.get(sessionId) ?? null
    if (current !== slot) return
    slotsRef.current.delete(sessionId)
    setSlotsVersion(v => v + 1)
  }, [])

  const getSlotsRef = useCallback(() => slotsRef.current, [])

  const setParkingHost = useCallback((host: HTMLElement | null) => {
    setParkingHostState(prev => (prev === host ? prev : host))
  }, [])

  // stableValue 引用永远不变，因为所有成员都是 useCallback 产出的稳定引用
  const stableValueRef = useRef<TerminalPanePortalStableValue>({
    registerSlot,
    unregisterSlot,
    getSlotsRef,
    setParkingHost
  })

  // dataValue 只在 slotsVersion 或 parkingHost 真正变化时才产生新引用
  const dataValue = useMemo<TerminalPanePortalDataValue>(
    () => ({ slotsVersion, parkingHost }),
    [slotsVersion, parkingHost]
  )

  return (
    <StableContext.Provider value={stableValueRef.current}>
      <DataContext.Provider value={dataValue}>
        {children}
      </DataContext.Provider>
    </StableContext.Provider>
  )
}

/**
 * useTerminalPanePortalStable - 只获取稳定的函数引用，不会因 slot 变化 re-render
 *
 * 适用于 TerminalPanePortalHost 等只需要 register/unregister 的组件。
 */
export const useTerminalPanePortalStable = (): TerminalPanePortalStableValue => {
  const context = useContext(StableContext)
  if (!context) {
    throw new Error('[TerminalPanePortal] Missing provider')
  }
  return context
}

/**
 * useTerminalPanePortal - 完整接口，兼容原有消费者
 *
 * 消费此 hook 的组件会在 slots 或 parkingHost 变化时 re-render。
 */
export const useTerminalPanePortal = (): TerminalPanePortalContextValue => {
  const stable = useContext(StableContext)
  const data = useContext(DataContext)
  if (!stable || !data) {
    throw new Error('[TerminalPanePortal] Missing provider')
  }
  // 每次 data 变化时读取最新的 slotsRef.current
  // 注意：这里返回的 slots 是 ref 本身的引用（mutable Map），
  // 消费者通过 slotsVersion 变化触发 re-render 后读取最新值。
  return {
    slots: stable.getSlotsRef(),
    slotsVersion: data.slotsVersion,
    registerSlot: stable.registerSlot,
    unregisterSlot: stable.unregisterSlot,
    parkingHost: data.parkingHost,
    setParkingHost: stable.setParkingHost
  }
}
