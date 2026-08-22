/**
 * 验证 `canEditAgentSettings` / `useCanEditAgentSettings` 的角色阈值是 `editor+`，
 * 与后端 `AgentService.update_agent` 的 `editor` 校验对齐（D3 决策）。
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { canEditAgentSettings, useCanEditAgentSettings } from '../useCanEditAgentSettings'

describe('canEditAgentSettings', () => {
  it('owner 可编辑', () => {
    expect(canEditAgentSettings('owner')).toBe(true)
  })

  it('admin 可编辑', () => {
    expect(canEditAgentSettings('admin')).toBe(true)
  })

  it('editor 可编辑（与后端一致，关键回归点）', () => {
    expect(canEditAgentSettings('editor')).toBe(true)
  })

  it('viewer 不可编辑', () => {
    expect(canEditAgentSettings('viewer')).toBe(false)
  })

  it('null/undefined 不可编辑（fail-closed）', () => {
    expect(canEditAgentSettings(null)).toBe(false)
    expect(canEditAgentSettings(undefined)).toBe(false)
  })

  // 防御未知 role 字符串：ROLE_LEVELS[未知 key] === undefined，
  // `undefined >= number` 在 JS 里恒为 false，因此整体是 fail-closed。
  it('未知 role 字符串不可编辑（fail-closed）', () => {
    expect(canEditAgentSettings('guest' as never)).toBe(false)
    expect(canEditAgentSettings('' as never)).toBe(false)
  })
})

describe('useCanEditAgentSettings', () => {
  it.each([
    ['owner', true],
    ['admin', true],
    ['editor', true],
    ['viewer', false],
  ] as const)('role=%s → %s', (role, expected) => {
    const { result } = renderHook(() => useCanEditAgentSettings(role))
    expect(result.current).toBe(expected)
  })

  it('null 角色返回 false', () => {
    const { result } = renderHook(() => useCanEditAgentSettings(null))
    expect(result.current).toBe(false)
  })

  it('undefined 角色返回 false', () => {
    const { result } = renderHook(() => useCanEditAgentSettings(undefined))
    expect(result.current).toBe(false)
  })
})
