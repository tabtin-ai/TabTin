import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useCommentRailController } from './useCommentRailController'

describe('useCommentRailController', () => {
  it('关闭后再次点击同一评论锚点可重新打开对应线程', () => {
    const { result } = renderHook(() => useCommentRailController())

    act(() => result.current.openThread('thread-1'))
    expect(result.current.railOpen).toBe(true)
    expect(result.current.activeThreadId).toBe('thread-1')

    for (let cycle = 0; cycle < 3; cycle += 1) {
      act(() => result.current.setRailOpen(false))
      expect(result.current.railOpen).toBe(false)
      expect(result.current.activeThreadId).toBeNull()

      act(() => result.current.openThread('thread-1'))
      expect(result.current.railOpen).toBe(true)
      expect(result.current.activeThreadId).toBe('thread-1')
    }
  })

  it('点击其他已有评论锚点时切换到对应线程', () => {
    const { result } = renderHook(() => useCommentRailController())

    act(() => result.current.openThread('thread-1'))
    act(() => result.current.openThread('thread-2'))

    expect(result.current.railOpen).toBe(true)
    expect(result.current.activeThreadId).toBe('thread-2')
  })

  it('发起新评论时打开评论栏且不保留旧线程选中态', () => {
    const { result } = renderHook(() => useCommentRailController())

    act(() => result.current.openThread('thread-1'))
    act(() => result.current.openThread(null))

    expect(result.current.railOpen).toBe(true)
    expect(result.current.activeThreadId).toBeNull()
  })

  it('点击非评论区域时取消选中，点击评论卡片或锚点时保留选中', () => {
    const { result } = renderHook(() => useCommentRailController())
    const plainText = document.createElement('span')
    const commentAnchor = document.createElement('span')
    commentAnchor.dataset.commentThreadId = 'thread-1'
    const card = document.createElement('article')
    card.dataset.commentThreadId = 'thread-1'
    const cardButton = document.createElement('button')
    card.append(cardButton)

    act(() => result.current.openThread('thread-1'))
    act(() => result.current.clearActiveThreadUnlessCommentTarget(commentAnchor))
    expect(result.current.activeThreadId).toBe('thread-1')

    act(() => result.current.clearActiveThreadUnlessCommentTarget(cardButton))
    expect(result.current.activeThreadId).toBe('thread-1')

    act(() => result.current.clearActiveThreadUnlessCommentTarget(plainText))
    expect(result.current.activeThreadId).toBeNull()
    expect(result.current.railOpen).toBe(true)
  })
})
