import { describe, expect, it, vi } from 'vitest'
import {
  resolveOrganizationRoot,
  resolveUserRoot,
  resolveWorkspaceMetadataRoot,
  warnIfSessionUnscoped,
} from '../src/spacePaths'

describe('spacePaths new-layout hard-cut ', () => {
  it('resolveUserRoot throws when userId missing', () => {
    expect(() => resolveUserRoot('/data', undefined as unknown as string)).toThrow(
      /userId is required/,
    )
  })

  it('resolveOrganizationRoot throws when orgId missing', () => {
    expect(() =>
      resolveOrganizationRoot('/data', 'u1', undefined as unknown as string),
    ).toThrow(/orgId is required/)
  })

  it('resolveWorkspaceMetadataRoot throws when workspaceId missing', () => {
    expect(() =>
      resolveWorkspaceMetadataRoot(
        '/data',
        'u1',
        'org-a',
        undefined as unknown as string,
      ),
    ).toThrow(/workspaceId is required/)
  })

  it('joins full ids without _unscoped', () => {
    expect(resolveUserRoot('/data', 'u1')).toBe('/data/users/u1')
    expect(resolveOrganizationRoot('/data', 'u1', 'org-a')).toBe(
      '/data/users/u1/organizations/org-a',
    )
    expect(resolveWorkspaceMetadataRoot('/data', 'u1', 'org-a', 'w1')).toBe(
      '/data/users/u1/organizations/org-a/workspaces/w1',
    )
  })

  it('warnIfSessionUnscoped warns about missing spaceId (not _unscoped fallback)', () => {
    const warn = vi.fn()
    warnIfSessionUnscoped(
      {
        runtimeId: 'abcdef12-3456-7890',
        spaceId: undefined,
        organizationId: 'org-a',
        origin: 'electron-host',
      },
      { warn },
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toMatch(/missing spaceId/)
    expect(warn.mock.calls[0][0]).toMatch(/no _unscoped fallback/)
    expect(warn.mock.calls[0][0]).not.toMatch(/falling back to _unscoped/)
  })

  it('warnIfSessionUnscoped is silent when spaceId present', () => {
    const warn = vi.fn()
    warnIfSessionUnscoped(
      {
        runtimeId: 'abcdef12-3456-7890',
        spaceId: 'sp-1',
        organizationId: 'org-a',
        origin: 'electron-host',
      },
      { warn },
    )
    expect(warn).not.toHaveBeenCalled()
  })
})
