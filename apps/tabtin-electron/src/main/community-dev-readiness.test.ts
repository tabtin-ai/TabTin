import { describe, expect, it, vi } from 'vitest'

import {
  COMMUNITY_DEV_READY_MARKER,
  reportCommunityDevReady,
} from './community-dev-readiness'

describe('reportCommunityDevReady', () => {
  it('writes the stable marker only for the community bootstrap', () => {
    const write = vi.fn()

    expect(
      reportCommunityDevReady({
        env: { TABTIN_COMMUNITY_DEV_BOOTSTRAP: '1' },
        write,
      }),
    ).toBe(true)
    expect(write).toHaveBeenCalledWith(`${COMMUNITY_DEV_READY_MARKER}\n`)
  })

  it('does not affect normal Electron development', () => {
    const write = vi.fn()

    expect(reportCommunityDevReady({ env: {}, write })).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })
})
