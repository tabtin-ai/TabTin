import { describe, expect, it } from 'vitest'

import {
  auditCreatedDayRange,
  buildOrganizationAuditRows,
  isSameLocalDay,
  normalizeAuditCreatedOn,
} from './organization-audit-display'

describe('normalizeAuditCreatedOn / clear-date path ', () => {
  it('treats empty, whitespace, and invalid values as no filter', () => {
    expect(normalizeAuditCreatedOn('')).toBe('')
    expect(normalizeAuditCreatedOn('   ')).toBe('')
    expect(normalizeAuditCreatedOn(null)).toBe('')
    expect(normalizeAuditCreatedOn(undefined)).toBe('')
    expect(normalizeAuditCreatedOn('2026/07/21')).toBe('')
    expect(normalizeAuditCreatedOn('yesterday')).toBe('')
  })

  it('keeps valid YYYY-MM-DD', () => {
    expect(normalizeAuditCreatedOn('2026-07-21')).toBe('2026-07-21')
    expect(normalizeAuditCreatedOn(' 2026-07-21 ')).toBe('2026-07-21')
  })
})

describe('auditCreatedDayRange', () => {
  it('sends no date bounds when cleared', () => {
    expect(auditCreatedDayRange('')).toEqual({})
    expect(auditCreatedDayRange('   ')).toEqual({})
    expect(auditCreatedDayRange('not-a-date')).toEqual({})
  })

  it('returns local-day ISO bounds for a valid day', () => {
    const range = auditCreatedDayRange('2026-07-21')
    expect(range.startAt).toBeTruthy()
    expect(range.endAt).toBeTruthy()
    expect(new Date(range.startAt!).toISOString()).toBe(range.startAt)
  })
})

describe('isSameLocalDay + buildOrganizationAuditRows clear restores baseline', () => {
  const orgId = 'org-a'
  const dayIso = new Date(2026, 6, 21, 10, 0, 0).toISOString()
  const otherIso = new Date(2026, 6, 20, 10, 0, 0).toISOString()

  const sensitive = [
    {
      id: 's1',
      actor_display_name: 'staff',
      permission_code: 'x',
      action: 'a1',
      target_type: 'organization',
      target_id: orgId,
      reason: 'r',
      ticket_id: '',
      before_json: {},
      after_json: {},
      request_id: '',
      created_at: dayIso,
    },
    {
      id: 's2',
      actor_display_name: 'staff',
      permission_code: 'x',
      action: 'a2',
      target_type: 'organization',
      target_id: orgId,
      reason: 'r',
      ticket_id: '',
      before_json: {},
      after_json: {},
      request_id: '',
      created_at: otherIso,
    },
  ]

  const organization = [
    {
      id: 'o1',
      action_type: 'organization_update',
      target_type: 'organization' as const,
      target_id: orgId,
      operator_name: 'owner',
      operator_id: 'u1',
      dry_run: false,
      success: true,
      message: 'm',
      error_message: '',
      request_payload: {},
      result_payload: {},
      created_at: dayIso,
    },
  ]

  it('empty createdOn keeps all three-source rows (baseline)', () => {
    expect(isSameLocalDay(dayIso, '')).toBe(true)
    const rows = buildOrganizationAuditRows({
      organizationId: orgId,
      sensitiveItems: sensitive,
      organizationItems: organization,
      billingItems: [],
      createdOn: '',
    })
    expect(rows).toHaveLength(3)
  })

  it('select day then clear day restores baseline length', () => {
    const filtered = buildOrganizationAuditRows({
      organizationId: orgId,
      sensitiveItems: sensitive,
      organizationItems: organization,
      billingItems: [],
      createdOn: '2026-07-21',
    })
    expect(filtered.length).toBeGreaterThan(0)
    expect(filtered.length).toBeLessThan(3)

    const restored = buildOrganizationAuditRows({
      organizationId: orgId,
      sensitiveItems: sensitive,
      organizationItems: organization,
      billingItems: [],
      createdOn: normalizeAuditCreatedOn(''),
    })
    expect(restored).toHaveLength(3)
  })
})
