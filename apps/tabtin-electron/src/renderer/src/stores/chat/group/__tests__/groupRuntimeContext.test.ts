import { describe, expect, it } from 'vitest'
import {
  buildAgentModeResolutionContext,
  normalizeAgentModeForContext,
  resolveAllowYoloFromOrganization,
  resolveApprovalGrantFromWorkspace,
  resolveDefaultAgentMode,
  resolveIsGroupSpace,
} from '../groupRuntimeContext'

describe('groupRuntimeContext', () => {
  it('resolveIsGroupSpace 仅在 is_active=true 时为 true', () => {
    expect(resolveIsGroupSpace(null)).toBe(false)
    expect(resolveIsGroupSpace({ enabled: true } as never)).toBe(false)
    expect(resolveIsGroupSpace({ enabled: true, is_active: true } as never)).toBe(true)
  })

  it('group 会话默认 mode 为 group', () => {
    const ctx = { allowYolo: true, isGroupSpace: true, approvalGrant: 'always_ask' as const }
    expect(resolveDefaultAgentMode(ctx, 'plan')).toBe('group')
  })

  it('非 group 会话读取本地偏好', () => {
    const ctx = { allowYolo: false, isGroupSpace: false, approvalGrant: 'always_ask' as const }
    expect(resolveDefaultAgentMode(ctx, 'plan')).toBe('plan')
    expect(resolveDefaultAgentMode(ctx, null)).toBe('agent')
  })

  it('group 会话 yolo 降级为 group', () => {
    const ctx = buildAgentModeResolutionContext(true, { is_active: true } as never)
    expect(normalizeAgentModeForContext('yolo', ctx)).toBe('group')
  })

  it('非 group 且 gate 关时 yolo 降级为 agent', () => {
    const ctx = { allowYolo: false, isGroupSpace: false, approvalGrant: 'always_ask' as const }
    expect(normalizeAgentModeForContext('yolo', ctx)).toBe('agent')
  })

  it('resolveAllowYoloFromOrganization 仅在 allow_member_yolo=true 时为 true', () => {
    expect(resolveAllowYoloFromOrganization(null)).toBe(false)
    expect(resolveAllowYoloFromOrganization({ settings: {} })).toBe(false)
    expect(resolveAllowYoloFromOrganization({ settings: { allow_member_yolo: false } })).toBe(false)
    expect(resolveAllowYoloFromOrganization({ settings: { allow_member_yolo: true } })).toBe(true)
  })

  it('组织未开放时 Workspace approvalGrant 强制 always_ask', () => {
    const workspace = { approval_grant: 'full_access' as const }
    expect(resolveApprovalGrantFromWorkspace(workspace, false)).toBe('always_ask')
    expect(buildAgentModeResolutionContext(false, null, workspace).approvalGrant).toBe('always_ask')
  })

  it('组织开放后读 Workspace approval_grant（含 full_access）', () => {
    expect(
      resolveApprovalGrantFromWorkspace({ approval_grant: 'auto' }, true),
    ).toBe('auto')
    expect(
      buildAgentModeResolutionContext(true, null, { approval_grant: 'full_access' }).approvalGrant,
    ).toBe('full_access')
  })

  it('#6021 Workspace 缺省 grant 为 always_ask（不再读 Agent legacy）', () => {
    expect(resolveApprovalGrantFromWorkspace({}, true)).toBe('always_ask')
    expect(buildAgentModeResolutionContext(true, null, {}).approvalGrant).toBe('always_ask')
    expect(buildAgentModeResolutionContext(true, null, null).approvalGrant).toBe('always_ask')
  })
})
