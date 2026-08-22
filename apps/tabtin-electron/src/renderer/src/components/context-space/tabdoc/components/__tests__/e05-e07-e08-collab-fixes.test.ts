/**
 * E-05 / E-07 / E-08 回归测试
 *
 * 由于 DocEditorView 和 useCollaborativeDocEditor 依赖复杂（novel、tiptap、
 * HocuspocusProvider 等），这里只测试修复引入的核心逻辑模式。
 */
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState, useEffect, useRef, useCallback } from 'react'
import type * as Y from 'yjs'

// ── E-05: ydoc 身份变化时 effectiveEditorKey 递增 ──

function useEffectiveEditorKey(editorKey: number, ydoc: Y.Doc | null | undefined) {
  const [ydocKeyBump, setYdocKeyBump] = useState(0)
  const prevYdocIdentityRef = useRef<Y.Doc | null | undefined>(undefined)
  useEffect(() => {
    if (prevYdocIdentityRef.current === undefined) {
      prevYdocIdentityRef.current = ydoc ?? null
      return
    }
    if (ydoc !== prevYdocIdentityRef.current) {
      setYdocKeyBump(prev => prev + 1)
    }
    prevYdocIdentityRef.current = ydoc ?? null
  }, [ydoc])
  return editorKey * 1000 + ydocKeyBump
}

describe('E-05: effectiveEditorKey 与 ydoc 联动', () => {
  it('ydoc 从 null 变为实例时，effectiveEditorKey 递增', () => {
    const fakeYDoc1 = { guid: 'doc-1' } as unknown as Y.Doc
    const { result, rerender } = renderHook(
      ({ editorKey, ydoc }) => useEffectiveEditorKey(editorKey, ydoc),
      { initialProps: { editorKey: 1, ydoc: null as Y.Doc | null } },
    )

    const initial = result.current
    expect(initial).toBe(1000) // 1 * 1000 + 0

    rerender({ editorKey: 1, ydoc: fakeYDoc1 })
    expect(result.current).toBe(1001) // bump +1
  })

  it('ydoc 身份不变时，effectiveEditorKey 不变', () => {
    const fakeYDoc = { guid: 'doc-1' } as unknown as Y.Doc
    const { result, rerender } = renderHook(
      ({ editorKey, ydoc }) => useEffectiveEditorKey(editorKey, ydoc),
      { initialProps: { editorKey: 1, ydoc: fakeYDoc } },
    )

    const initial = result.current
    rerender({ editorKey: 1, ydoc: fakeYDoc })
    expect(result.current).toBe(initial)
  })

  it('editorKey 变化（文档切换）同样改变 effectiveEditorKey', () => {
    const { result, rerender } = renderHook(
      ({ editorKey, ydoc }) => useEffectiveEditorKey(editorKey, ydoc),
      { initialProps: { editorKey: 1, ydoc: null as Y.Doc | null } },
    )

    expect(result.current).toBe(1000)
    rerender({ editorKey: 2, ydoc: null })
    expect(result.current).toBe(2000) // 2 * 1000 + 0
  })

  it('ydoc 变化多次，key 持续递增', () => {
    const doc1 = { guid: '1' } as unknown as Y.Doc
    const doc2 = { guid: '2' } as unknown as Y.Doc
    const { result, rerender } = renderHook(
      ({ editorKey, ydoc }) => useEffectiveEditorKey(editorKey, ydoc),
      { initialProps: { editorKey: 1, ydoc: null as Y.Doc | null } },
    )

    rerender({ editorKey: 1, ydoc: doc1 })
    expect(result.current).toBe(1001)

    rerender({ editorKey: 1, ydoc: doc2 })
    expect(result.current).toBe(1002)

    rerender({ editorKey: 1, ydoc: null })
    expect(result.current).toBe(1003)
  })
})

// ── E-07: waitForSave 多并发 resolver ──

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

function useWaitForSaveMulti() {
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const saveStateRef = useRef<SaveState>('idle')
  const resolversRef = useRef<Set<(state: SaveState) => void>>(new Set())

  useEffect(() => {
    saveStateRef.current = saveState
    if (resolversRef.current.size > 0) {
      for (const resolver of resolversRef.current) {
        resolver(saveState)
      }
    }
  }, [saveState])

  const waitForSave = useCallback(async (): Promise<'ok' | 'timeout' | 'error'> => {
    const current = saveStateRef.current
    if (current === 'saved' || current === 'idle') return 'ok'
    if (current === 'error') return 'error'

    return new Promise<'ok' | 'timeout' | 'error'>((resolve) => {
      let settled = false
      const resolver = (state: SaveState) => {
        if (settled) return
        if (state === 'saved' || state === 'idle') {
          settled = true
          clearTimeout(timeout)
          resolversRef.current.delete(resolver)
          resolve('ok')
        } else if (state === 'error') {
          settled = true
          clearTimeout(timeout)
          resolversRef.current.delete(resolver)
          resolve('error')
        }
      }
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        resolversRef.current.delete(resolver)
        resolve('timeout')
      }, 500) // shortened for test
      resolversRef.current.add(resolver)
    })
  }, [])

  return { saveState, setSaveState, waitForSave, resolversRef }
}

describe('E-07: waitForSave 多并发 resolver', () => {
  it('两个并发 waitForSave 都能正确 resolve', async () => {
    const { result } = renderHook(() => useWaitForSaveMulti())

    act(() => result.current.setSaveState('saving'))

    let result1: string | undefined
    let result2: string | undefined

    const p1 = result.current.waitForSave().then(r => { result1 = r })
    const p2 = result.current.waitForSave().then(r => { result2 = r })

    // 两个 resolver 都注册了
    expect(result.current.resolversRef.current.size).toBe(2)

    // 触发 saveState 变化
    await act(async () => {
      result.current.setSaveState('saved')
    })

    await p1
    await p2

    expect(result1).toBe('ok')
    expect(result2).toBe('ok')
    expect(result.current.resolversRef.current.size).toBe(0)
  })

  it('error 状态时 resolver 也能正确 resolve', async () => {
    const { result } = renderHook(() => useWaitForSaveMulti())

    act(() => result.current.setSaveState('saving'))

    let result1: string | undefined
    const p1 = result.current.waitForSave().then(r => { result1 = r })

    await act(async () => {
      result.current.setSaveState('error')
    })

    await p1
    expect(result1).toBe('error')
  })

  it('已处于 saved 状态时立即返回 ok', async () => {
    const { result } = renderHook(() => useWaitForSaveMulti())
    act(() => result.current.setSaveState('saved'))

    let r: string | undefined
    await act(async () => {
      r = await result.current.waitForSave()
    })
    expect(r).toBe('ok')
    expect(result.current.resolversRef.current.size).toBe(0)
  })
})

// ── E-08: token 获取与 documentId 解耦 ──

describe('E-08: token 不随 documentId 变化重新获取', () => {
  it('documentId 变化不触发 token 重新获取', () => {
    const fetchToken = vi.fn().mockResolvedValue('jwt-token-123')

    const { rerender } = renderHook(
      ({ documentId, userId }: { documentId: string; userId: string }) => {
        const [token, setToken] = useState('')
        useEffect(() => {
          fetchToken()
            .then((t: string) => setToken(prev => t || prev))
            .catch(() => {})
        }, [userId]) // E-08: depends on userId, not documentId
        return { token, documentId }
      },
      { initialProps: { documentId: 'doc-1', userId: 'u1' } },
    )

    expect(fetchToken).toHaveBeenCalledTimes(1)

    rerender({ documentId: 'doc-2', userId: 'u1' })
    expect(fetchToken).toHaveBeenCalledTimes(1) // unchanged

    rerender({ documentId: 'doc-3', userId: 'u1' })
    expect(fetchToken).toHaveBeenCalledTimes(1) // still unchanged
  })

  it('userId 变化时重新获取 token', () => {
    const fetchToken = vi.fn().mockResolvedValue('jwt-token-123')

    const { rerender } = renderHook(
      ({ documentId, userId }: { documentId: string; userId: string }) => {
        const [token, setToken] = useState('')
        useEffect(() => {
          fetchToken()
            .then((t: string) => setToken(prev => t || prev))
            .catch(() => {})
        }, [userId])
        return { token, documentId }
      },
      { initialProps: { documentId: 'doc-1', userId: 'u1' } },
    )

    expect(fetchToken).toHaveBeenCalledTimes(1)

    rerender({ documentId: 'doc-1', userId: 'u2' })
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  it('token 获取失败不清空已有 token（防闪烁）', async () => {
    let callCount = 0
    const fetchToken = vi.fn().mockImplementation(() => {
      callCount++
      if (callCount === 1) return Promise.resolve('valid-token')
      return Promise.reject(new Error('network error'))
    })

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string }) => {
        const [token, setToken] = useState('')
        useEffect(() => {
          fetchToken()
            .then((t: string) => setToken(prev => t || prev))
            .catch(() => {})
        }, [userId])
        return token
      },
      { initialProps: { userId: 'u1' } },
    )

    // Wait for the first fetch to complete
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect(result.current).toBe('valid-token')

    // Switch user — second fetch will reject
    rerender({ userId: 'u2' })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })

    // Token should not be cleared on failure
    expect(result.current).toBe('valid-token')
  })
})
