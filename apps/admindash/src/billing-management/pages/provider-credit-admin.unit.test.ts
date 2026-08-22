import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const pageDir = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(pageDir, '../..')
const pageSource = readFileSync(join(pageDir, 'ProviderCreditManagement.tsx'), 'utf8')
const apiSource = readFileSync(join(pageDir, '../api/provider-credit-admin.ts'), 'utf8')
const appSource = readFileSync(join(sourceRoot, 'App.tsx'), 'utf8')
const sidebarSource = readFileSync(join(sourceRoot, 'components/layout/sidebar.tsx'), 'utf8')
const permissionsSource = readFileSync(join(sourceRoot, 'lib/admin-permissions.ts'), 'utf8')

describe('Provider Credit AdminDash contract', () => {
  it('registers a permission-protected route and billing sidebar entry', () => {
    expect(appSource).toContain('path="billing/provider-credit"')
    expect(appSource).toContain('ADMIN_PERMISSION.PROVIDER_CREDIT_VIEW')
    expect(appSource).toContain('ADMIN_PERMISSION.PROVIDER_CREDIT_OPERATE')
    expect(appSource).toContain('ADMIN_PERMISSION.PROVIDER_CREDIT_ADMIN')
    expect(sidebarSource).toContain("title: '供应商赠送额度'")
    expect(sidebarSource).toContain("href: '/billing/provider-credit'")
    expect(permissionsSource).toContain("PROVIDER_CREDIT_VIEW: 'provider_credit:view'")
    expect(permissionsSource).toContain("PROVIDER_CREDIT_OPERATE: 'provider_credit:operate'")
    expect(permissionsSource).toContain("PROVIDER_CREDIT_ADMIN: 'provider_credit:admin'")
  })

  it('provides campaign, grant, transaction, adjustment, revoke and report operations', () => {
    for (const path of [
      '/provider-credit/campaigns',
      '/provider-credit/grants',
      '/provider-credit/transactions',
      '/adjust',
      '/revoke',
      '/provider-credit/reports/campaign/',
    ]) {
      expect(apiSource).toContain(path)
    }
    expect(pageSource).toContain('活动管理')
    expect(pageSource).toContain('组织额度')
    expect(pageSource).toContain('额度流水')
    expect(pageSource).toContain('SensitiveActionConfirmDialog')
  })

  it('keeps Provider Credit operations isolated from wallet and payment endpoints', () => {
    expect(apiSource).not.toMatch(/\/wallet/i)
    expect(apiSource).not.toMatch(/PaymentOrder/i)
    expect(apiSource).not.toMatch(/\/payment/i)
    expect(pageSource).toContain('不会充值到组织钱包')
  })

  it('uses stable provider key and model UUID scope instead of display names', () => {
    expect(pageSource).toContain('provider_key')
    expect(pageSource).toContain('model UUID')
    expect(pageSource).toContain('model.provider_key === form.provider_key')
    expect(pageSource).toContain('value={model.id}')
    expect(pageSource).toContain('value={tier.tier_type}')
  })
})
