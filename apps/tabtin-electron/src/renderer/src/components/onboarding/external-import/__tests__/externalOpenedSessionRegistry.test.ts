import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetExternalOpenedSession,
  getExternalOpenedSessionIds,
  isExternalOpenedSession,
  rememberExternalOpenedSession,
  resolveExternalOpenedSession,
  syncExternalOpenedSessions,
} from '../externalOpenedSessionRegistry'

const target = {
  source: 'codex',
  sourceSessionId: 'source-1',
  title: '外部历史',
  openedSessionId: 'session-1',
}

afterEach(() => syncExternalOpenedSessions([]))

describe('externalOpenedSessionRegistry', () => {
  it('syncs trimmed targets and exposes an isolated id snapshot', () => {
    syncExternalOpenedSessions([{ ...target, openedSessionId: ' session-1 ' }])

    expect(isExternalOpenedSession('session-1')).toBe(true)
    expect(resolveExternalOpenedSession(' session-1 ')).toEqual(target)

    const snapshot = getExternalOpenedSessionIds() as Set<string>
    snapshot.clear()
    expect(isExternalOpenedSession('session-1')).toBe(true)
  })

  it('keeps existing metadata when remembered again without a target', () => {
    rememberExternalOpenedSession('session-1', target)
    rememberExternalOpenedSession(' session-1 ')

    expect(resolveExternalOpenedSession('session-1')).toEqual(target)
  })

  it('forgets the target and supports id-only registrations', () => {
    rememberExternalOpenedSession('session-1')
    expect(isExternalOpenedSession('session-1')).toBe(true)
    expect(resolveExternalOpenedSession('session-1')).toBeNull()

    forgetExternalOpenedSession(' session-1 ')
    expect(isExternalOpenedSession('session-1')).toBe(false)
  })
})
