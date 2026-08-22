/**
 * TurnEndLayout Context — 向 MessageBubble / Thinking 等后代暴露回合收尾高度预算。
 * 无 Provider 时 idle + no-op，兼容历史消息独立渲染与预览。
 */

import React, { createContext, useContext, type ReactNode } from 'react'
import type { TurnEndLayoutPhaseSnapshot } from './turnEndLayoutPhase'

export type TurnEndLayoutValue = TurnEndLayoutPhaseSnapshot & {
  markClosingUiReady: () => void
  release: () => void
}

const noop = (): void => {}

export const IDLE_TURN_END_LAYOUT: TurnEndLayoutValue = Object.freeze({
  phase: 'idle',
  closingUiReady: false,
  shouldHoldThinkingPreviewBudget: false,
  shouldHoldClosingSpacer: false,
  markClosingUiReady: noop,
  release: noop,
})

const TurnEndLayoutContext = createContext<TurnEndLayoutValue | null>(null)

export type TurnEndLayoutProviderProps = {
  value: TurnEndLayoutValue
  children: ReactNode
}

export function TurnEndLayoutProvider({
  value,
  children,
}: TurnEndLayoutProviderProps): React.ReactElement {
  return (
    <TurnEndLayoutContext.Provider value={value}>
      {children}
    </TurnEndLayoutContext.Provider>
  )
}

export function useTurnEndLayout(): TurnEndLayoutValue {
  return useContext(TurnEndLayoutContext) ?? IDLE_TURN_END_LAYOUT
}
