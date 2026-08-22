import { afterEach, describe, expect, it, vi } from 'vitest'

import { installMainProcessErrorHooks } from './main-process-errors'

describe('installMainProcessErrorHooks', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports uncaught exceptions with their authoritative source', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const reportError = vi.fn()

    installMainProcessErrorHooks({
      log: { debug: vi.fn(), error: vi.fn() },
      reportError,
    })

    const error = new Error('boom')
    handlers.get('uncaughtException')?.(error)

    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError).toHaveBeenCalledWith(error, 'main_uncaught_exception')
  })

  it('normalizes rejected values and identifies unhandled rejections', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const reportError = vi.fn()

    installMainProcessErrorHooks({
      log: { debug: vi.fn(), error: vi.fn() },
      reportError,
    })
    handlers.get('unhandledRejection')?.('rejected')

    expect(reportError).toHaveBeenCalledOnce()
    expect(reportError.mock.calls[0]?.[0]).toEqual(new Error('rejected'))
    expect(reportError.mock.calls[0]?.[1]).toBe('main_unhandled_rejection')
  })

  it('does not report expected broken-pipe noise', () => {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler)
      return process
    }) as typeof process.on)
    const reportError = vi.fn()

    installMainProcessErrorHooks({
      log: { debug: vi.fn(), error: vi.fn() },
      reportError,
    })
    handlers.get('uncaughtException')?.(new Error('write EPIPE'))
    handlers.get('unhandledRejection')?.(new Error('socket ECONNRESET'))

    expect(reportError).not.toHaveBeenCalled()
  })
})
