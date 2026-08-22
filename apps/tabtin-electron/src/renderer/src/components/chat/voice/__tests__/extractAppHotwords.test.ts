import { describe, expect, it, beforeEach, vi } from 'vitest'

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: vi.fn(() => ({ selectedOrganization: null })),
  },
}))
vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: vi.fn(() => ({ selectedSpace: null })),
  },
}))

import { extractAppHotwords } from '../extractAppHotwords'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'

describe('extractAppHotwords', () => {
  beforeEach(() => {
    vi.mocked(useOrganizationStore.getState).mockReturnValue({ selectedOrganization: null } as any)
    vi.mocked(useSpaceStore.getState).mockReturnValue({ selectedSpace: null } as any)
  })

  it('should return empty when no organization or space', () => {
    expect(extractAppHotwords()).toEqual([])
  })

  it('should extract single-word organization name', () => {
    vi.mocked(useOrganizationStore.getState).mockReturnValue({
      selectedOrganization: { name: 'Marketing' },
    } as any)
    const result = extractAppHotwords()
    expect(result).toContain('Marketing')
  })

  it('should split multi-word organization name and include original', () => {
    vi.mocked(useOrganizationStore.getState).mockReturnValue({
      selectedOrganization: { name: 'AI Research Lab' },
    } as any)
    const result = extractAppHotwords()
    expect(result).toContain('AI')
    expect(result).toContain('Research')
    expect(result).toContain('Lab')
    expect(result).toContain('AI Research Lab')
  })

  it('should extract space name', () => {
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      selectedSpace: { name: '产品设计空间' },
    } as any)
    const result = extractAppHotwords()
    expect(result).toContain('产品设计空间')
  })

  it('should merge organization and space names, deduplicated', () => {
    vi.mocked(useOrganizationStore.getState).mockReturnValue({
      selectedOrganization: { name: 'TabTin' },
    } as any)
    vi.mocked(useSpaceStore.getState).mockReturnValue({
      selectedSpace: { name: 'TabTin Space' },
    } as any)
    const result = extractAppHotwords()
    const tabTinCount = result.filter(w => w === 'TabTin').length
    expect(tabTinCount).toBe(1)
    expect(result).toContain('Space')
    expect(result).toContain('TabTin Space')
  })

  it('should filter out single-character words', () => {
    vi.mocked(useOrganizationStore.getState).mockReturnValue({
      selectedOrganization: { name: 'A Big Team' },
    } as any)
    const result = extractAppHotwords()
    expect(result).not.toContain('A')
    expect(result).toContain('Big')
    expect(result).toContain('Team')
  })

  it('should split by common delimiters', () => {
    vi.mocked(useOrganizationStore.getState).mockReturnValue({
      selectedOrganization: { name: 'Dev·Design_Ops' },
    } as any)
    const result = extractAppHotwords()
    expect(result).toContain('Dev')
    expect(result).toContain('Design')
    expect(result).toContain('Ops')
  })
})
