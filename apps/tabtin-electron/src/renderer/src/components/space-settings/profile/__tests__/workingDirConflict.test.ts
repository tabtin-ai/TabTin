import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  findSpaceByWorkingDirConflict,
  getSelectedWorkingDirCreateBlocker,
  isWorkingDirConflictError,
  normalizeWorkingDirForCompare,
} from '../workingDirConflict'

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: vi.fn(),
  },
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: vi.fn(() => ({ currentDevice: { id: 'dev-1' } })),
  },
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

import { useSpaceStore } from '@stores/useSpaceStore'

describe('workingDirConflict', () => {
  beforeEach(() => {
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      spaces: [
        {
          id: 'space-a',
          name: 'Alpha',
          organization_id: 'wt-1',
          control_device_id: 'dev-1',
          working_dir: '/Users/me/proj',
          normalized_working_dir: '/Users/me/proj',
        },
        {
          id: 'space-b',
          name: 'Beta',
          organization_id: 'wt-1',
          control_device_id: 'dev-1',
          working_dir: '/Users/me/other',
          normalized_working_dir: '/Users/me/other',
        },
        {
          id: 'space-win',
          name: 'WinProj',
          organization_id: 'wt-1',
          control_device_id: 'dev-1',
          working_dir: 'C:\\Users\\me\\proj',
          normalized_working_dir: 'C:\\Users\\me\\proj',
        },
      ],
    } as never)
  })

  it('normalizeWorkingDirForCompare strips trailing slashes', () => {
    expect(normalizeWorkingDirForCompare('/Users/me/proj/')).toBe('/Users/me/proj')
    expect(normalizeWorkingDirForCompare('/Users/me/proj')).toBe('/Users/me/proj')
  })

  it('normalizeWorkingDirForCompare lowercases Windows paths', () => {
    expect(normalizeWorkingDirForCompare('C:\\Users\\Me\\Proj\\')).toBe('c:\\users\\me\\proj')
    expect(normalizeWorkingDirForCompare('c:/Users/me/proj')).toBe('c:/users/me/proj')
  })

  it('isWorkingDirConflictError detects backend codes and messages', () => {
    expect(isWorkingDirConflictError('WORKING_DIR_CONFLICT: duplicate')).toBe(true)
    expect(isWorkingDirConflictError('该工作目录已绑定到当前设备上的另一个 Space')).toBe(true)
    expect(
      isWorkingDirConflictError(
        'This working directory is already bound to another Workspace on this device',
      ),
    ).toBe(true)
    expect(isWorkingDirConflictError('other error')).toBe(false)
  })

  it('findSpaceByWorkingDirConflict matches normalized path on same device', () => {
    const found = findSpaceByWorkingDirConflict({
      organizationId: 'wt-1',
      targetWorkingDir: '/Users/me/proj/',
      currentDeviceId: 'dev-1',
      excludeSpaceId: 'space-b',
    })
    expect(found?.id).toBe('space-a')
  })

  it('findSpaceByWorkingDirConflict matches Windows path case-insensitively', () => {
    const found = findSpaceByWorkingDirConflict({
      organizationId: 'wt-1',
      targetWorkingDir: 'c:\\users\\me\\proj\\',
      currentDeviceId: 'dev-1',
    })
    expect(found?.id).toBe('space-win')
  })

  it('findSpaceByWorkingDirConflict ignores excluded space', () => {
    const found = findSpaceByWorkingDirConflict({
      organizationId: 'wt-1',
      targetWorkingDir: '/Users/me/proj',
      currentDeviceId: 'dev-1',
      excludeSpaceId: 'space-a',
    })
    expect(found).toBeUndefined()
  })

  it('getSelectedWorkingDirCreateBlocker allows empty dir (default-dir fallback)', () => {
    expect(
      getSelectedWorkingDirCreateBlocker({
        organizationId: 'wt-1',
        selectedWorkingDir: '',
      }),
    ).toEqual({ blocked: false })
  })

  it('getSelectedWorkingDirCreateBlocker blocks occupied selected dir', () => {
    const result = getSelectedWorkingDirCreateBlocker({
      organizationId: 'wt-1',
      selectedWorkingDir: '/Users/me/proj/',
    })
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.existing.id).toBe('space-a')
    }
  })

  it('getSelectedWorkingDirCreateBlocker allows free selected dir', () => {
    expect(
      getSelectedWorkingDirCreateBlocker({
        organizationId: 'wt-1',
        selectedWorkingDir: '/Users/me/brand-new',
      }),
    ).toEqual({ blocked: false })
  })

  it('getSelectedWorkingDirCreateBlocker excludes current space when relocating', () => {
    expect(
      getSelectedWorkingDirCreateBlocker({
        organizationId: 'wt-1',
        selectedWorkingDir: '/Users/me/proj',
        excludeSpaceId: 'space-a',
      }),
    ).toEqual({ blocked: false })
  })

  it('getSelectedWorkingDirCreateBlocker still blocks other space when relocating', () => {
    const result = getSelectedWorkingDirCreateBlocker({
      organizationId: 'wt-1',
      selectedWorkingDir: '/Users/me/other',
      excludeSpaceId: 'space-a',
    })
    expect(result.blocked).toBe(true)
    if (result.blocked) {
      expect(result.existing.id).toBe('space-b')
    }
  })
})
