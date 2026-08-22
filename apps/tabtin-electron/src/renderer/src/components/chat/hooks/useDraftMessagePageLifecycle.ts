import { useEffect, useRef } from 'react'
import { leaveDraftMessagePage } from '@/stores/chat/session/draftMessageSessionCoordinator'

export function useDraftMessagePageLifecycle(input: {
  active: boolean
  draftScopeKey: string | null | undefined
}): void {
  const pageRef = useRef<{ active: boolean; draftScopeKey: string | null }>({
    active: false,
    draftScopeKey: null,
  })
  const mountGenerationRef = useRef(0)

  useEffect(() => {
    const generation = ++mountGenerationRef.current
    return () => {
      const departingPage = pageRef.current
      queueMicrotask(() => {
        // React StrictMode 会模拟 cleanup→remount；新 setup 已推进 generation，不是真离开。
        // eslint-disable-next-line react-hooks/exhaustive-deps -- 必须读取微任务执行时的最新 generation。
        if (mountGenerationRef.current !== generation) return
        if (departingPage.active && departingPage.draftScopeKey) {
          leaveDraftMessagePage(departingPage.draftScopeKey)
        }
      })
    }
  }, [])

  useEffect(() => {
    const previous = pageRef.current
    const draftScopeKey = input.draftScopeKey ?? null
    if (
      previous.active
      && previous.draftScopeKey
      && (!input.active || previous.draftScopeKey !== draftScopeKey)
    ) {
      leaveDraftMessagePage(previous.draftScopeKey)
    }
    pageRef.current = { active: input.active, draftScopeKey }
  }, [input.active, input.draftScopeKey])
}
