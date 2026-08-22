import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useInlineEdit } from '../useInlineEdit'

describe('useInlineEdit', () => {
  it('commit 校验通过后立即清除编辑态，即使 onCommit 挂起', async () => {
    let resolveCommit!: () => void
    const onCommit = vi.fn(() => new Promise<void>(resolve => {
      resolveCommit = resolve
    }))

    const { result } = renderHook(() => useInlineEdit())

    act(() => {
      result.current.start('新标题', 'res-1')
    })
    expect(result.current.isActive).toBe(true)

    let commitPromise!: Promise<boolean>
    act(() => {
      commitPromise = result.current.commit(onCommit)
    })

    expect(result.current.isActive).toBe(false)

    resolveCommit()
    await act(async () => {
      await commitPromise
    })
    expect(onCommit).toHaveBeenCalledWith('新标题', 'res-1', undefined)
  })

  it('onCommit 失败时不重新打开输入框', async () => {
    const onCommit = vi.fn().mockRejectedValue(new Error('rename failed'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = renderHook(() => useInlineEdit())

    act(() => {
      result.current.start('新标题', 'res-1')
    })

    await act(async () => {
      const ok = await result.current.commit(onCommit)
      expect(ok).toBe(false)
    })

    expect(result.current.isActive).toBe(false)
    consoleError.mockRestore()
  })

  it('committedRef 防止 Enter→blur 双重提交', async () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useInlineEdit())

    act(() => {
      result.current.start('新标题', 'res-1')
    })

    await act(async () => {
      const first = result.current.commit(onCommit)
      const second = result.current.commit(onCommit)
      await Promise.all([first, second])
    })

    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('创建态可在空值 blur 后保留输入行，等待用户重新聚焦', () => {
    const onCommit = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useInlineEdit())

    act(() => {
      result.current.start('', undefined, { type: 'folder' })
    })
    act(() => {
      result.current.getInputProps(onCommit, { retainEmptyOnBlur: true }).onBlur()
    })

    expect(result.current.isActive).toBe(true)
    expect(onCommit).not.toHaveBeenCalled()
  })
})
