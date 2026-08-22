import { useLayoutEffect, useRef, type RefObject } from 'react'
import { resolveHistoricalMessageEnterKeys } from './messageEnterMotion'

export interface UseMessageEnterMotionInput {
  contentElementRef: RefObject<HTMLDivElement | null>
  messageEnterKeys: readonly string[]
  scopeKey: string | null
  isRestoringSession: boolean
  showAwaitingThoughtPlaceholder: boolean
  awaitingThoughtHandoffKeys: ReadonlySet<string>
}

export function useMessageEnterMotion({
  contentElementRef,
  messageEnterKeys,
  scopeKey,
  isRestoringSession,
  showAwaitingThoughtPlaceholder,
  awaitingThoughtHandoffKeys,
}: UseMessageEnterMotionInput): void {
  const messageEnterScopeRef = useRef(scopeKey)
  const messageEnterSealedRef = useRef(false)
  const previousMessageEnterKeysRef = useRef<readonly string[]>([])
  const seenMessageEnterKeysRef = useRef(new Set<string>())
  const previousAwaitingThoughtPlaceholderRef = useRef(showAwaitingThoughtPlaceholder)

  // 新消息入场只改已提交的虚拟行 DOM：初始历史 / restore / prepend 先记 seen；
  // 当前生命周期新追加且已在视口内的行才加一次 class。避免 render 期全局账本在
  // StrictMode / 并发渲染中提前消费入场资格，也不改变 MessageBubble props。
  // eslint-disable-next-line complexity -- 入场动画账本需要一次性协调 session 切换、restore、等待壳交接和 DOM 清理。
  useLayoutEffect(() => {
    const isAwaitingThoughtHandoff = previousAwaitingThoughtPlaceholderRef.current && !showAwaitingThoughtPlaceholder
    const scopeChanged = messageEnterScopeRef.current !== scopeKey
    if (scopeChanged) {
      messageEnterScopeRef.current = scopeKey
      messageEnterSealedRef.current = false
      previousMessageEnterKeysRef.current = []
      seenMessageEnterKeysRef.current = new Set()
    }

    if (!messageEnterSealedRef.current) {
      seenMessageEnterKeysRef.current = new Set(messageEnterKeys)
      previousMessageEnterKeysRef.current = messageEnterKeys
      messageEnterSealedRef.current = true
      previousAwaitingThoughtPlaceholderRef.current = showAwaitingThoughtPlaceholder
      return
    }

    const historicalKeys = isRestoringSession
      ? messageEnterKeys
      : resolveHistoricalMessageEnterKeys(previousMessageEnterKeysRef.current, messageEnterKeys)
    for (const key of historicalKeys) seenMessageEnterKeysRef.current.add(key)

    const rowsByKey = new Map<string, HTMLElement>()
    contentElementRef.current?.querySelectorAll<HTMLElement>('[data-message-enter-key]').forEach((row) => {
      const key = row.dataset.messageEnterKey
      if (key) rowsByKey.set(key, row)
    })
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    for (const key of messageEnterKeys) {
      if (seenMessageEnterKeysRef.current.has(key)) continue
      // 即使当前不在虚拟窗口也立即记 seen：稍后滚进视口时它已是历史，不能补播入场。
      seenMessageEnterKeysRef.current.add(key)
      if (isRestoringSession || reducedMotion) continue
      // message_start 前的等待壳已即时呈现过 Agent 身份与状态。真实 assistant
      // 行接管的是同一个视觉对象，不应再从 opacity:0 重播一次消息入场。
      if (isAwaitingThoughtHandoff && awaitingThoughtHandoffKeys.has(key)) continue
      const row = rowsByKey.get(key)
      if (!row) continue
      row.classList.add('chat-motion-message-enter')
      const clearEnterClass = (event: AnimationEvent) => {
        if (event.target !== row) return
        row.classList.remove('chat-motion-message-enter')
        row.removeEventListener('animationend', clearEnterClass)
      }
      row.addEventListener('animationend', clearEnterClass)
    }
    previousMessageEnterKeysRef.current = messageEnterKeys
    previousAwaitingThoughtPlaceholderRef.current = showAwaitingThoughtPlaceholder
  }, [
    awaitingThoughtHandoffKeys,
    contentElementRef,
    isRestoringSession,
    messageEnterKeys,
    scopeKey,
    showAwaitingThoughtPlaceholder,
  ])
}
