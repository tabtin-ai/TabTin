import { describe, expect, it } from 'vitest'

import { checkLeafItemActive } from './sidebar-nav-active'

describe('checkLeafItemActive ', () => {
  it('highlights only the current billing usage sibling', () => {
    expect(checkLeafItemActive('/billing/events', '/billing/events')).toBe(true)
    expect(checkLeafItemActive('/billing/events', '/billing/cost-analysis')).toBe(false)
    expect(checkLeafItemActive('/billing/events', '/billing/storage')).toBe(false)

    expect(checkLeafItemActive('/billing/cost-analysis', '/billing/cost-analysis')).toBe(true)
    expect(checkLeafItemActive('/billing/storage', '/billing/storage')).toBe(true)
  })

  it('highlights only the current billing payment-order sibling', () => {
    expect(checkLeafItemActive('/billing/payment-orders', '/billing/reconciliation')).toBe(false)
    expect(checkLeafItemActive('/billing/reconciliation', '/billing/reconciliation')).toBe(true)
    expect(checkLeafItemActive('/billing/audit-log', '/billing/payment-orders')).toBe(false)
  })

  it('highlights only the current anomaly sibling', () => {
    expect(checkLeafItemActive('/billing/anomalies', '/billing/budget')).toBe(false)
    expect(checkLeafItemActive('/billing/budget', '/billing/budget')).toBe(true)
    expect(
      checkLeafItemActive('/billing/organization-cleanup', '/billing/organization-cleanup')
    ).toBe(true)
  })

  it('highlights only the current admin-account sibling', () => {
    expect(checkLeafItemActive('/admin-accounts', '/admin-rbac')).toBe(false)
    expect(checkLeafItemActive('/admin-rbac', '/admin-rbac')).toBe(true)
    expect(checkLeafItemActive('/admin-accounts', '/admin-accounts/xyz')).toBe(true)
  })

  it('distinguishes governance admin-log siblings by query', () => {
    const path = '/governance/admin-logs'
    expect(checkLeafItemActive(path, path, '')).toBe(true)
    expect(checkLeafItemActive(path, path, '?type=login')).toBe(false)

    expect(checkLeafItemActive(`${path}?type=login`, path, '?type=login')).toBe(true)
    expect(checkLeafItemActive(`${path}?type=login`, path, '?type=sensitive')).toBe(false)
    expect(checkLeafItemActive(`${path}?type=login`, path, '')).toBe(false)
    expect(checkLeafItemActive(`${path}?type=sensitive`, path, '?type=login')).toBe(false)
  })

  it('keeps filter-query leaves active (month/page/q)', () => {
    const path = '/billing/organization-credit-explanation'
    expect(checkLeafItemActive(path, path, '')).toBe(true)
    expect(checkLeafItemActive(path, path, '?month=2026-08&page=1')).toBe(true)
    expect(checkLeafItemActive(path, path, '?q=foo&month=2024-08')).toBe(true)
    expect(checkLeafItemActive('/billing/wallets', path, '?month=2026-08')).toBe(false)
  })
})
