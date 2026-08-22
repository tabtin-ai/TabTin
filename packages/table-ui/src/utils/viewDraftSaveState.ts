export type ViewDraftSaveDisabledReason =
  | 'readonly'
  | 'locked'
  | 'personal-view'
  | 'no-changes'
  | null

export const VIEW_DRAFT_SAVE_DISABLED_REASON_KEYS = {
  readonly: 'view:actions.saveDisabledReadonly',
  locked: 'view:actions.saveDisabledLocked',
  'personal-view': 'view:actions.saveDisabledPersonalView',
  'no-changes': 'view:actions.saveDisabledNoChanges',
} as const satisfies Record<Exclude<ViewDraftSaveDisabledReason, null>, string>

export interface ResolveViewDraftSaveDisabledReasonInput {
  hasCurrentView: boolean
  isReadonly: boolean
  isViewLocked: boolean
  isPersonalViewEnabled: boolean
  hasDirtyDraft: boolean
}

/**
 * 返回共享视图保存按钮的首要禁用原因。
 *
 * 权限与锁定优先于个人视图，避免提示用户“退出个人视图即可保存”，
 * 但退出后仍会被只读权限或视图锁定继续拦截。
 */
export const resolveViewDraftSaveDisabledReason = ({
  hasCurrentView,
  isReadonly,
  isViewLocked,
  isPersonalViewEnabled,
  hasDirtyDraft,
}: ResolveViewDraftSaveDisabledReasonInput): ViewDraftSaveDisabledReason => {
  if (!hasCurrentView) return null
  if (isReadonly) return 'readonly'
  if (isViewLocked) return 'locked'
  if (isPersonalViewEnabled) return 'personal-view'
  if (!hasDirtyDraft) return 'no-changes'
  return null
}
