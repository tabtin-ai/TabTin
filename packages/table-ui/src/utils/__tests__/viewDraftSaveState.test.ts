import { describe, expect, it } from 'vitest'
import { resolveViewDraftSaveDisabledReason } from '../viewDraftSaveState'

const enabledState = {
  hasCurrentView: true,
  isReadonly: false,
  isViewLocked: false,
  isPersonalViewEnabled: false,
  hasDirtyDraft: true,
}

describe('resolveViewDraftSaveDisabledReason', () => {
  it.each([
    ['readonly', { isReadonly: true }],
    ['locked', { isViewLocked: true }],
    ['personal-view', { isPersonalViewEnabled: true }],
    ['no-changes', { hasDirtyDraft: false }],
  ] as const)('返回 %s 禁用原因', (reason, patch) => {
    expect(resolveViewDraftSaveDisabledReason({ ...enabledState, ...patch })).toBe(reason)
  })

  it('权限与锁定优先，提示的解除动作不会误导用户', () => {
    expect(resolveViewDraftSaveDisabledReason({
      ...enabledState,
      isReadonly: true,
      isViewLocked: true,
      isPersonalViewEnabled: true,
    })).toBe('readonly')

    expect(resolveViewDraftSaveDisabledReason({
      ...enabledState,
      isViewLocked: true,
      isPersonalViewEnabled: true,
    })).toBe('locked')
  })

  it('可保存或没有当前视图时不返回禁用原因', () => {
    expect(resolveViewDraftSaveDisabledReason(enabledState)).toBeNull()
    expect(resolveViewDraftSaveDisabledReason({
      ...enabledState,
      hasCurrentView: false,
      isReadonly: true,
    })).toBeNull()
  })
})
