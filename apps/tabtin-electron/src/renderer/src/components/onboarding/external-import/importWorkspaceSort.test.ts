import { describe, expect, it } from 'vitest'
import { compareWorkspacesByLatestDesc } from './importWorkspaceSort'

describe('compareWorkspacesByLatestDesc', () => {
  it('sorts by latest session updatedAt descending', () => {
    const older = { sessions: [{ updatedAt: '2026-07-20T00:00:00.000Z' }, { updatedAt: '2026-07-01T00:00:00.000Z' }] }
    const newer = { sessions: [{ updatedAt: '2026-07-25T12:00:00.000Z' }] }
    const list = [older, newer].sort(compareWorkspacesByLatestDesc)
    expect(list[0]).toBe(newer)
    expect(list[1]).toBe(older)
  })

  it('breaks ties by session count', () => {
    const ts = '2026-07-25T12:00:00.000Z'
    const few = { sessions: [{ updatedAt: ts }] }
    const many = { sessions: [{ updatedAt: ts }, { updatedAt: ts }, { updatedAt: ts }] }
    const list = [few, many].sort(compareWorkspacesByLatestDesc)
    expect(list[0]).toBe(many)
  })
})
