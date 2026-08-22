import { describe, expect, it } from 'vitest'

import { shouldForceReconnectAfterTableRestore } from './tableRestoreSync'

describe('#5898 table history restore sync mode', () => {
  it('does not reconnect after the server already resynced the live Y.Doc', () => {
    expect(shouldForceReconnectAfterTableRestore('resync')).toBe(false)
  })

  it('keeps reconnect fallback for force-close, failed, and legacy responses', () => {
    expect(shouldForceReconnectAfterTableRestore('force_close')).toBe(true)
    expect(shouldForceReconnectAfterTableRestore('failed')).toBe(true)
    expect(shouldForceReconnectAfterTableRestore(undefined)).toBe(true)
  })

  it('does not reconnect when restore made no data changes', () => {
    expect(shouldForceReconnectAfterTableRestore('none')).toBe(false)
  })
})
