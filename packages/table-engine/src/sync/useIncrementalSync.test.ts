import { describe, expect, it } from 'vitest'
import { snapshotTableRequestHeaders } from '@tabtin/table-core'
import {
  handleIncrementalFullReloadSignal,
  runIncrementalRequest,
} from './useIncrementalSync'

describe('runIncrementalRequest', () => {
  it('scopes the embedded parent header to the incremental request', async () => {
    let capturedHeaders: Record<string, string> = {}

    await runIncrementalRequest(
      { 'X-TabTin-Parent-Document-Id': 'doc-parent' },
      async () => {
        capturedHeaders = snapshotTableRequestHeaders()
      },
    )

    expect(capturedHeaders).toEqual({
      'X-TabTin-Parent-Document-Id': 'doc-parent',
    })
    expect(snapshotTableRequestHeaders()).toEqual({})
  })
})

describe('handleIncrementalFullReloadSignal', () => {
  it('runs a full reload when a physical delete invalidates the delta window', async () => {
    let reloadCount = 0

    const handled = await handleIncrementalFullReloadSignal(
      { requires_full_reload: true },
      async () => { reloadCount += 1 },
    )

    expect(handled).toBe(true)
    expect(reloadCount).toBe(1)
  })

  it('leaves ordinary incremental responses on the merge path', async () => {
    let reloadCount = 0

    const handled = await handleIncrementalFullReloadSignal(
      { requires_full_reload: false },
      () => { reloadCount += 1 },
    )

    expect(handled).toBe(false)
    expect(reloadCount).toBe(0)
  })

  it('propagates full reload failures so the caller can retry', async () => {
    await expect(handleIncrementalFullReloadSignal(
      { requires_full_reload: true },
      async () => { throw new Error('reload unavailable') },
    )).rejects.toThrow('reload unavailable')
  })

  it('rejects an invalid host that cannot perform the required reload', async () => {
    await expect(handleIncrementalFullReloadSignal(
      { requires_full_reload: true },
    )).rejects.toThrow('requires a full reload handler')
  })
})
