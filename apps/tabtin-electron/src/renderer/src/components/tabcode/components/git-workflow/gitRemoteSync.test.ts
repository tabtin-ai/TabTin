import { describe, expect, it } from 'vitest'
import {
  canPushBranch,
  getPushDisabledReasonKey,
  resolvePushRemote,
} from './gitRemoteSync'
import type { GitBranchMeta } from '@shared/git-types'

function meta(partial: Partial<GitBranchMeta> = {}): GitBranchMeta {
  return {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    isDetached: false,
    ...partial,
  }
}

describe('gitRemoteSync', () => {
  it('allows push when ahead>0 or first upstream publish', () => {
    expect(canPushBranch(meta({ ahead: 2 }))).toBe(true)
    expect(canPushBranch(meta({ ahead: 0, upstream: null }))).toBe(true)
    expect(canPushBranch(meta({ ahead: 0, upstream: 'origin/main' }))).toBe(false)
  })

  it('blocks push for detached or behind', () => {
    expect(canPushBranch(meta({ isDetached: true, ahead: 1 }))).toBe(false)
    expect(canPushBranch(meta({ behind: 1, ahead: 1 }))).toBe(false)
    expect(getPushDisabledReasonKey(meta({ isDetached: true }))).toBe(
      'gitFlow.pushDisabledDetached',
    )
    expect(getPushDisabledReasonKey(meta({ behind: 3 }))).toBe(
      'gitFlow.pushDisabledBehind',
    )
    expect(getPushDisabledReasonKey(meta({ ahead: 0 }))).toBe(
      'gitFlow.pushDisabledNoAhead',
    )
  })

  it('resolves push remote from upstream', () => {
    expect(resolvePushRemote('origin/main')).toBe('origin')
    expect(resolvePushRemote(null)).toBe('origin')
    expect(resolvePushRemote('')).toBe('origin')
  })
})
