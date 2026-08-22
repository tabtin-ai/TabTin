/**
 * Organization 级浏览器 partition builder 单测（边界改造 Phase 3a）。
 *
 * 这是 main / renderer 共用的纯函数 —— 两侧都靠它把 organizationId 折成同一个
 * partition 字符串，保证"用户 tab 与 Agent tab 在同 organization 落同一个 cookie 罐"。
 */
import { describe, expect, it } from 'vitest'

import {
  ORGANIZATION_BROWSER_PARTITION_PREFIX,
  buildOrganizationBrowserPartition,
  isOrganizationBrowserPartition,
} from './browser-env'

describe('buildOrganizationBrowserPartition', () => {
  it('正常 organizationId → tabtin:organization:{id}:browser', () => {
    expect(buildOrganizationBrowserPartition('wt-123')).toBe('tabtin:organization:wt-123:browser')
    expect(buildOrganizationBrowserPartition('abc_DEF-456')).toBe('tabtin:organization:abc_DEF-456:browser')
  })

  it('前缀常量与产物一致', () => {
    expect(buildOrganizationBrowserPartition('x').startsWith(ORGANIZATION_BROWSER_PARTITION_PREFIX)).toBe(true)
  })

  it('空 / null / undefined / 全非法字符 → 空串（调用方回落默认）', () => {
    expect(buildOrganizationBrowserPartition('')).toBe('')
    expect(buildOrganizationBrowserPartition('   ')).toBe('')
    expect(buildOrganizationBrowserPartition(null)).toBe('')
    expect(buildOrganizationBrowserPartition(undefined)).toBe('')
    // 全是非法字符 → sanitize 后变 `___`（非空，保留以避免不同 organization 撞同一罐）
    expect(buildOrganizationBrowserPartition('@@@')).toBe('tabtin:organization:___:browser')
  })

  it('非法字符被 sanitize（路径穿越 / 空格 / 斜杠）', () => {
    // `wt` + `/../`(4 个非法字符→4 个下划线) + `x` + ` `(1) + `y`
    expect(buildOrganizationBrowserPartition('wt/../x y')).toBe('tabtin:organization:wt____x_y:browser')
  })

  it('超长 organizationId 截断到 128 字符', () => {
    const long = 'a'.repeat(200)
    const out = buildOrganizationBrowserPartition(long)
    // tabtin:organization: + 128 + :browser
    expect(out).toBe(`tabtin:organization:${'a'.repeat(128)}:browser`)
  })
})

describe('isOrganizationBrowserPartition', () => {
  it('识别 organization partition（含 persist: 前缀）', () => {
    expect(isOrganizationBrowserPartition('tabtin:organization:wt-1:browser')).toBe(true)
    expect(isOrganizationBrowserPartition('persist:tabtin:organization:wt-1:browser')).toBe(true)
  })

  it('非 organization partition 返回 false（承重墙：session / env 不算）', () => {
    expect(isOrganizationBrowserPartition('tabtin:env:default')).toBe(false)
    expect(isOrganizationBrowserPartition('tabtin:session:cs-1')).toBe(false)
    expect(isOrganizationBrowserPartition('')).toBe(false)
    expect(isOrganizationBrowserPartition(null)).toBe(false)
    expect(isOrganizationBrowserPartition(undefined)).toBe(false)
  })
})
