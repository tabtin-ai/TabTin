import { describe, expect, it } from 'vitest'
import {
  awaitInFlightContextSync,
  registerInFlightContextSync,
} from '../contextSyncInFlight'

describe('contextSyncInFlight', () => {
  it('awaits registered in-flight HTTP sync', async () => {
    let resolved = false
    const promise = new Promise<void>(resolve => {
      setTimeout(() => {
        resolved = true
        resolve()
      }, 10)
    })
    registerInFlightContextSync('sess-1', promise)
    await awaitInFlightContextSync('sess-1')
    expect(resolved).toBe(true)
  })

  it('resolves immediately when no in-flight sync exists', async () => {
    await awaitInFlightContextSync('sess-missing')
  })
})
