/**
 * 相对时间刷新用的轻量 tick —— 只让订阅叶子重渲，不进 MessageBubble props。
 * （：全局 timeTick 曾打穿气泡 memo，导致可见气泡整表跟渲）
 */

import React, { createContext, useContext } from 'react'

const MessageTimeTickContext = createContext(0)

export function MessageTimeTickProvider({
  tick,
  children,
}: {
  tick: number
  children: React.ReactNode
}): React.ReactElement {
  return (
    <MessageTimeTickContext.Provider value={tick}>
      {children}
    </MessageTimeTickContext.Provider>
  )
}

/** 供相对时间叶子订阅；MessageBubble 本体不要用。 */
export function useMessageTimeTick(): number {
  return useContext(MessageTimeTickContext)
}
