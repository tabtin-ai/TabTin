import { describe, expect, it } from 'vitest'
import { resolveExternalSidebarTabIntent } from '../resolveExternalSidebarTabIntent'

describe('resolveExternalSidebarTabIntent', () => {
  it('prefers pending over meta', () => {
    const intent = resolveExternalSidebarTabIntent({
      pending: 'git',
      meta: 'files',
      metaAlreadyConsumed: false,
      isGitRepo: true,
    })
    expect(intent).toEqual({
      tab: 'git',
      source: 'pending',
      defer: false,
    })
  })

  it('defers git intent until the repo is confirmed', () => {
    const intent = resolveExternalSidebarTabIntent({
      pending: 'git',
      meta: undefined,
      metaAlreadyConsumed: false,
      isGitRepo: false,
    })
    expect(intent).toEqual({
      tab: 'git',
      source: 'pending',
      defer: true,
    })
  })

  it('does not defer git intent when assumeGitRepo is set', () => {
    const intent = resolveExternalSidebarTabIntent({
      pending: 'git',
      meta: undefined,
      metaAlreadyConsumed: false,
      isGitRepo: false,
      assumeGitRepo: true,
    })
    expect(intent).toEqual({
      tab: 'git',
      source: 'pending',
      defer: false,
    })
  })

  it('falls back to meta only when pending is empty and meta is fresh', () => {
    const intent = resolveExternalSidebarTabIntent({
      pending: null,
      meta: 'git',
      metaAlreadyConsumed: false,
      isGitRepo: true,
    })
    expect(intent).toEqual({
      tab: 'git',
      source: 'meta',
      defer: false,
    })
  })

  it('ignores meta after it was already consumed', () => {
    const intent = resolveExternalSidebarTabIntent({
      pending: null,
      meta: 'git',
      metaAlreadyConsumed: true,
      isGitRepo: true,
    })
    expect(intent).toBeNull()
  })

  it('rejects unknown meta values', () => {
    const intent = resolveExternalSidebarTabIntent({
      pending: null,
      meta: 'history',
      metaAlreadyConsumed: false,
      isGitRepo: true,
    })
    expect(intent).toBeNull()
  })
})
