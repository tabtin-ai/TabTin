import { afterEach, describe, expect, it } from 'vitest'
import {
  clearAllLocallySubmittedSessions,
  forgetLocallySubmittedSession,
  getLocallySubmittedSessionIds,
  rememberLocallySubmittedSession,
} from '../locallySubmittedSessionRegistry'

afterEach(() => {
  clearAllLocallySubmittedSessions()
})

describe('locallySubmittedSessionRegistry', () => {
  it('remembers and forgets session ids', () => {
    rememberLocallySubmittedSession('  sess-1  ')
    expect(getLocallySubmittedSessionIds().has('sess-1')).toBe(true)

    forgetLocallySubmittedSession('sess-1')
    expect(getLocallySubmittedSessionIds().has('sess-1')).toBe(false)
  })

  it('ignores blank ids', () => {
    rememberLocallySubmittedSession('   ')
    expect(getLocallySubmittedSessionIds().size).toBe(0)
  })

  it('clearAll wipes the registry (logout / reset)', () => {
    rememberLocallySubmittedSession('a')
    rememberLocallySubmittedSession('b')
    clearAllLocallySubmittedSessions()
    expect(getLocallySubmittedSessionIds().size).toBe(0)
  })
})
