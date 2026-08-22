import { describe, expect, it, vi } from 'vitest'
import { executeGuardedCreate } from '../useGuardedCreate'

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

describe('executeGuardedCreate', () => {
  it('sets busy true during create and false after success', async () => {
    const creatingRef = { current: false }
    const setBusy = vi.fn()
    let resolveCreate: (value: { id: string }) => void = () => undefined
    const createPromise = new Promise<{ id: string }>((resolve) => {
      resolveCreate = resolve
    })

    const run = executeGuardedCreate({
      creatingRef,
      setBusy,
      appId: 'tabdoc',
      appLabel: 'TabDoc',
      isAppEnabled: () => true,
      t: ((key: string) => key) as never,
      create: () => createPromise,
      onSuccess: vi.fn(),
    })

    expect(creatingRef.current).toBe(true)
    expect(setBusy).toHaveBeenCalledWith(true)

    resolveCreate({ id: 'doc-1' })
    await run

    expect(creatingRef.current).toBe(false)
    expect(setBusy).toHaveBeenLastCalledWith(false)
  })

  it('ignores re-entry while creating', async () => {
    const creatingRef = { current: false }
    const create = vi.fn().mockResolvedValue({ id: '1' })
    const onSuccess = vi.fn()

    const first = executeGuardedCreate({
      creatingRef,
      appId: 'tabdata',
      appLabel: 'TabData',
      isAppEnabled: () => true,
      t: ((key: string) => key) as never,
      create,
      onSuccess,
    })
    const second = executeGuardedCreate({
      creatingRef,
      appId: 'tabdata',
      appLabel: 'TabData',
      isAppEnabled: () => true,
      t: ((key: string) => key) as never,
      create,
      onSuccess,
    })

    await Promise.all([first, second])
    expect(create).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledTimes(1)
  })
})
