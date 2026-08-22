/**
 * useTurnEndLayoutController — MessageList 持有的 turn-end 状态机适配层。
 *
 * machine 在 effect 内创建；cleanup dispose，StrictMode 不得复用已 disposed 实例。
 * 通过 useSyncExternalStore 订阅稳定 snapshot。
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import {
  createTurnEndLayoutPhaseMachine,
  type TurnEndLayoutPhaseMachine,
  type TurnEndLayoutPhaseSnapshot,
} from './turnEndLayoutPhase'
import type { TurnEndLayoutValue } from './TurnEndLayoutContext'

const IDLE_SNAPSHOT: TurnEndLayoutPhaseSnapshot = Object.freeze({
  phase: 'idle',
  closingUiReady: false,
  shouldHoldThinkingPreviewBudget: false,
  shouldHoldClosingSpacer: false,
})

type TurnEndLayoutStore = {
  machine: TurnEndLayoutPhaseMachine | null
  listeners: Set<() => void>
}

function createBrowserDeps() {
  return {
    now: (): number =>
      typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now(),
    schedule: (cb: () => void, ms: number): number => window.setTimeout(cb, ms),
    cancel: (id: number): void => {
      window.clearTimeout(id)
    },
  }
}

export type UseTurnEndLayoutControllerResult = {
  snapshot: TurnEndLayoutPhaseSnapshot
  beginTurnEnd: () => void
  markClosingUiReady: () => void
  release: () => void
  /** 可直接喂给 TurnEndLayoutProvider 的 value。 */
  providerValue: TurnEndLayoutValue
}

export function useTurnEndLayoutController(): UseTurnEndLayoutControllerResult {
  const storeRef = useRef<TurnEndLayoutStore | null>(null)
  if (storeRef.current == null) {
    storeRef.current = {
      machine: null,
      listeners: new Set(),
    }
  }

  useEffect(() => {
    const store = storeRef.current!
    const machine = createTurnEndLayoutPhaseMachine(createBrowserDeps())
    store.machine = machine

    const unsub = machine.subscribe(() => {
      for (const listener of store.listeners) listener()
    })
    // 新 machine 就绪：通知订阅者（即便仍 idle，引用也会从模块常量切到 machine snapshot）
    for (const listener of store.listeners) listener()

    return () => {
      unsub()
      machine.dispose()
      if (store.machine === machine) {
        store.machine = null
      }
      for (const listener of store.listeners) listener()
    }
  }, [])

  const subscribe = useCallback((onStoreChange: () => void): (() => void) => {
    const store = storeRef.current!
    store.listeners.add(onStoreChange)
    return () => {
      store.listeners.delete(onStoreChange)
    }
  }, [])

  const getSnapshot = useCallback((): TurnEndLayoutPhaseSnapshot => {
    return storeRef.current?.machine?.getSnapshot() ?? IDLE_SNAPSHOT
  }, [])

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, () => IDLE_SNAPSHOT)

  const beginTurnEnd = useCallback((): void => {
    storeRef.current?.machine?.beginTurnEnd()
  }, [])

  const markClosingUiReady = useCallback((): void => {
    storeRef.current?.machine?.markClosingUiReady()
  }, [])

  const release = useCallback((): void => {
    storeRef.current?.machine?.release()
  }, [])

  const providerValue = useMemo<TurnEndLayoutValue>(
    () => ({
      phase: snapshot.phase,
      closingUiReady: snapshot.closingUiReady,
      shouldHoldThinkingPreviewBudget: snapshot.shouldHoldThinkingPreviewBudget,
      shouldHoldClosingSpacer: snapshot.shouldHoldClosingSpacer,
      markClosingUiReady,
      release,
    }),
    [snapshot, markClosingUiReady, release],
  )

  return {
    snapshot,
    beginTurnEnd,
    markClosingUiReady,
    release,
    providerValue,
  }
}
