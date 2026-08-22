/**
 * cli-context: organizationRoot 兜底契约
 *
 * 钉住「chat 路径在 sync 之后兜底写入 organizationRoot」机制的核心 API
 * `setCLIOrganizationRootIfMissing` 的行为契约。
 *
 * 背景（2026-05-23 现场实测发现）：spaceId=c8346f92 下所有 session 的
 * system prompt 缺 `<environment>` / `<shell_runtime>` / `<platform_data>`
 * 三段——根因是 `space:set-active` 链路在某些 Space 切换路径下被
 * silent catch（`apps/tabtin-electron/src/renderer/src/adapters/app-shell-init.ts:86-88`）
 * 失败，全局单例 `currentOrganizationRoot` 仍为初始 null，
 * `runtimeIdentity` 的三元门闩 `(spaceId && organizationId && workspaceRoot)`
 * 整组失败 → `buildSystemPrompt` 跳过三段。
 *
 * 修复在 `ElectronAgentHost.handleQueryInternal` chat 入口加独立 fallback：
 * sync 把 spaceId/organizationId 设上后，若 organizationRoot 仍 null，用与
 * `space:set-active` surface 同款 fallback 算法补一个，并通过本函数写入
 * 全局单例。**严格只在缺失时写入**——避免覆盖 `space:set-active` 写入
 * 的权威值（可能是用户自定义的 agent.working_dir，跟 fallback 计算
 * 不一定相等）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getCLIOrganizationRoot,
  setCLISpaceContextState,
  setCLIOrganizationRootIfMissing,
} from '../cli-context'

describe('setCLIOrganizationRootIfMissing · 契约', () => {
  beforeEach(() => {
    // 清空全局单例，确保每个测试从干净状态开始
    setCLISpaceContextState(null, null, null, null)
  })

  afterEach(() => {
    setCLISpaceContextState(null, null, null, null)
  })

  it('当前为 null → 写入新值', () => {
    expect(getCLIOrganizationRoot()).toBeNull()
    setCLIOrganizationRootIfMissing('/Users/me/projects/foo')
    expect(getCLIOrganizationRoot()).toBe('/Users/me/projects/foo')
  })

  it('当前已有值 → 不覆盖（保护 space:set-active 写入的权威值）', () => {
    setCLISpaceContextState('s1', null, 'wt1', '/authoritative/agent/working/dir')
    expect(getCLIOrganizationRoot()).toBe('/authoritative/agent/working/dir')

    // 即使传入合法 fallback 路径，也不应覆盖已有值
    setCLIOrganizationRootIfMissing('/different/fallback/path')
    expect(getCLIOrganizationRoot()).toBe('/authoritative/agent/working/dir')
  })

  it('传入空字符串 → 不写入（避免把全局单例清成空字符串）', () => {
    expect(getCLIOrganizationRoot()).toBeNull()
    setCLIOrganizationRootIfMissing('')
    expect(getCLIOrganizationRoot()).toBeNull()
  })

  it('当前已是空字符串 → 视为缺失，允许写入', () => {
    // 用 4 参 setCLISpaceContextState 把 organizationRoot 设为空字符串
    // （现实中不会发生，但守门要兼容）。length === 0 视为缺失。
    setCLISpaceContextState('s1', null, 'wt1', '')
    expect(getCLIOrganizationRoot()).toBe('')

    setCLIOrganizationRootIfMissing('/fallback/path')
    expect(getCLIOrganizationRoot()).toBe('/fallback/path')
  })

  it('多次调用幂等 → 第一次写入后续不变', () => {
    setCLIOrganizationRootIfMissing('/first/value')
    setCLIOrganizationRootIfMissing('/second/value')
    setCLIOrganizationRootIfMissing('/third/value')
    expect(getCLIOrganizationRoot()).toBe('/first/value')
  })

  it('不写 process.env.TABTIN_*——单一职责只补 organizationRoot', () => {
    const originalSpace = process.env.TABTIN_SPACE_ID
    const originalWt = process.env.TABTIN_ORGANIZATION_ID
    delete process.env.TABTIN_SPACE_ID
    delete process.env.TABTIN_ORGANIZATION_ID

    try {
      setCLIOrganizationRootIfMissing('/some/root')
      // 不应有任何 process.env.TABTIN_*_ID 副作用
      expect(process.env.TABTIN_SPACE_ID).toBeUndefined()
      expect(process.env.TABTIN_ORGANIZATION_ID).toBeUndefined()
    } finally {
      if (originalSpace) process.env.TABTIN_SPACE_ID = originalSpace
      if (originalWt) process.env.TABTIN_ORGANIZATION_ID = originalWt
    }
  })
})
