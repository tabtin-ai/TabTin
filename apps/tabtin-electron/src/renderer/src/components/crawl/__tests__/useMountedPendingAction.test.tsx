import { StrictMode, type PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useMountedPendingAction } from '../useMountedPendingAction'

describe('useMountedPendingAction', () => {
  it('StrictMode effect replay 后 begin/finish 仍清除 pending，真实卸载后拒绝 setState', () => {
    const wrapper = ({ children }: PropsWithChildren) => (
      <StrictMode>{children}</StrictMode>
    )
    const { result, unmount } = renderHook(
      () => useMountedPendingAction<string>(),
      { wrapper, reactStrictMode: true },
    )

    act(() => {
      expect(result.current.begin('take-over')).toBe(true)
    })
    expect(result.current.pendingAction).toBe('take-over')

    act(() => {
      expect(result.current.finish()).toBe(true)
    })
    expect(result.current.pendingAction).toBeNull()

    const finishAfterUnmount = result.current.finish
    unmount()
    expect(finishAfterUnmount()).toBe(false)
  })

  it('pending promise resolve 前卸载，不再结束本地 pending 状态', async () => {
    const { result, unmount } = renderHook(() => useMountedPendingAction<string>())
    let resolve!: () => void
    const pending = new Promise<void>((done) => {
      resolve = done
    })

    act(() => result.current.begin('take-over'))
    const finish = result.current.finish
    const completion = pending.then(() => finish())
    unmount()
    resolve()

    await expect(completion).resolves.toBe(false)
  })

  it('pending promise reject 前卸载，不再结束本地 pending 状态', async () => {
    const { result, unmount } = renderHook(() => useMountedPendingAction<string>())
    let reject!: (error: Error) => void
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail
    })

    act(() => result.current.begin('stop'))
    const finish = result.current.finish
    const completion = pending.catch(() => finish())
    unmount()
    reject(new Error('expected test rejection'))

    await expect(completion).resolves.toBe(false)
  })
})
