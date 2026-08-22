import { describe, expect, it, vi } from 'vitest'

import { parseSkillsAddInput } from '../src/application/skills/skill-installation.js'
import { cleanupDisabledSkill, materializeEnabledSkill } from '../src/application/skills/skill-enablement.js'
import { SkillsApplication } from '../src/application/skills/index.js'

describe('skills application modules', () => {
  it('owns import, optional enable, and enable degradation behind one interface', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { skill_key: 'user:review', normalized_files: [] } },
      })
      .mockResolvedValueOnce({ status: 503, data: { message: 'enable unavailable' } })

    const application = new SkillsApplication({
      organizationId: 'org-1',
      request,
      requireUserId: () => 'user-1',
      materializeApp: vi.fn(),
    })
    const result = await application.import({
      spaceId: 'space-1', url: 'https://example.com/SKILL.md', enable: true,
    })

    expect(request).toHaveBeenNthCalledWith(1, 'POST', '/api/skills/import', {
      space_id: 'space-1',
      url: 'https://example.com/SKILL.md',
    })
    expect(request).toHaveBeenNthCalledWith(2, 'POST', '/api/skills/user%3Areview/enable', {
      space_id: 'space-1',
    })
    expect(result).toEqual({
      data: { skill_key: 'user:review', normalized_files: [], enabled: false },
      enableError: 'enable unavailable',
    })
  })

  it('parses pasted skills commands without exposing process execution to the route', () => {
    expect(parseSkillsAddInput('npx skills add owner/repo --skill docs --skill=slides -y')).toEqual({
      source: 'owner/repo',
      skills: ['docs', 'slides'],
    })
  })

  it('delegates app materialization through the application port', async () => {
    const materializeApp = vi.fn(async () => ({ installed: 1, errors: [] }))
    const context = {
      organizationId: 'org-1',
      requireUserId: () => 'user-1',
      request: vi.fn(),
      materializeApp,
    }

    await expect(materializeEnabledSkill({
      canonicalKey: 'app:office/meeting-notes',
      djangoData: { source: 'app' },
      spaceId: 'space-1',
      context,
    })).resolves.toEqual({ installed: true })
    expect(materializeApp).toHaveBeenCalledWith({
      organizationId: 'org-1',
      spaceId: 'space-1',
      userId: 'user-1',
      appId: 'office',
      slug: 'meeting-notes',
    })
  })

  it('keeps ordinary disable non-destructive', async () => {
    const result = await cleanupDisabledSkill({
      canonicalKey: 'user:review',
      remove: false,
      context: {
        organizationId: 'org-1',
        requireUserId: () => { throw new Error('must not resolve filesystem target') },
        request: vi.fn(),
        materializeApp: vi.fn(),
      },
    })
    expect(result).toEqual({ removed: false })
  })
})
