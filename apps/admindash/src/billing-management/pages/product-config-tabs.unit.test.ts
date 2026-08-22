import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 商品与定价应对齐组织详情：路径停在 /billing/products，用 hash 切模块，
 * 不再对子模块做 pathname 跳转。
 */
describe('ProductConfigPage tab contract', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'ProductConfigPage.tsx'),
    'utf8'
  )

  it('drives tabs via hash navigate and embeds modules', () => {
    expect(src).toMatch(/navigate\(`#\$\{tab\}`/)
    expect(src).toMatch(/location\.hash/)
    expect(src).toMatch(/<MembershipManagement embedded/)
    expect(src).toMatch(/<RuntimeConfigPage embedded/)
  })

  it('does not navigate to legacy product subpaths', () => {
    expect(src).not.toMatch(/navigate\(['"`]\/billing\/products\//)
    expect(src).not.toMatch(/navigate\(['"`]\/billing\/runtime-config/)
  })

  it('shows overview aggregates instead of placeholder copy and create CTA', () => {
    expect(src).not.toMatch(/待子页汇总/)
    expect(src).not.toMatch(/按子页查看/)
    expect(src).not.toMatch(/新建配置/)
    expect(src).toMatch(/listMembershipTiers/)
    expect(src).toMatch(/listPricingRules/)
    expect(src).toMatch(/getRuntimeConfig/)
  })
})
