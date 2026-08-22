import { describe, expect, it } from 'vitest'
import { resolveManualCompactContext } from './chatInputManualCompactContext'

describe('resolveManualCompactContext', () => {
  it('keeps an existing A session scoped to A while the foreground is B', () => {
    expect(resolveManualCompactContext(
      { organization_id: 'org-a', space_id: 'space-a' },
      'space-b',
      { id: 'space-b', organization_id: 'org-b' },
      [
        { id: 'space-a', organization_id: 'org-a' },
        { id: 'space-b', organization_id: 'org-b' },
      ],
    )).toEqual({
      organizationId: 'org-a',
      spaceId: 'space-a',
    })
  })

  it('rejects an A session without a Space when the candidate Space belongs to B', () => {
    expect(resolveManualCompactContext(
      { organization_id: 'org-a' },
      'space-b',
      { id: 'space-b', organization_id: 'org-b' },
      [
        { id: 'space-a', organization_id: 'org-a' },
        { id: 'space-b', organization_id: 'org-b' },
      ],
    )).toBeNull()
  })

  it('keeps an A session without a Space when the candidate Space also belongs to A', () => {
    expect(resolveManualCompactContext(
      { organization_id: 'org-a' },
      'space-a',
      { id: 'space-b', organization_id: 'org-b' },
      [
        { id: 'space-a', organization_id: 'org-a' },
        { id: 'space-b', organization_id: 'org-b' },
      ],
    )).toEqual({
      organizationId: 'org-a',
      spaceId: 'space-a',
    })
  })

  it('derives the organization from the requested resource Space', () => {
    expect(resolveManualCompactContext(
      null,
      'space-a',
      { id: 'space-b', organization_id: 'org-b' },
      [
        { id: 'space-a', organization_id: 'org-a' },
        { id: 'space-b', organization_id: 'org-b' },
      ],
    )).toEqual({
      organizationId: 'org-a',
      spaceId: 'space-a',
    })
  })
})
