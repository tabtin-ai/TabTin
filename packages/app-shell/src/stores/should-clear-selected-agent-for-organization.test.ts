import { describe, expect, it } from 'vitest'
import { shouldClearSelectedAgentForOrganization } from './use-agent-store.js'

describe('shouldClearSelectedAgentForOrganization ', () => {
  it('无 selectedAgent 时不清', () => {
    expect(shouldClearSelectedAgentForOrganization(null, 'org-b')).toBe(false)
    expect(shouldClearSelectedAgentForOrganization(undefined, 'org-b')).toBe(false)
  })

  it('目标 organization 为空时清掉残留身份', () => {
    expect(
      shouldClearSelectedAgentForOrganization(
        { organization_id: 'org-a' },
        null,
      ),
    ).toBe(true)
    expect(
      shouldClearSelectedAgentForOrganization(
        { organization_id: 'org-a' },
        undefined,
      ),
    ).toBe(true)
  })

  it('同组织保留', () => {
    expect(
      shouldClearSelectedAgentForOrganization(
        { organization_id: 'org-a' },
        'org-a',
      ),
    ).toBe(false)
  })

  it('跨组织必须清', () => {
    expect(
      shouldClearSelectedAgentForOrganization(
        { organization_id: 'org-a' },
        'org-b',
      ),
    ).toBe(true)
  })
})
