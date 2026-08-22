export const isViewLocked = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true
    if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off' || normalized === '') {
      return false
    }
  }
  return Boolean(value)
}

/**
 * 视图右键菜单：重命名/编辑/复制/置顶/设首页/删除等写操作是否禁用。
 * 表级只读或视图锁定都会禁用；解锁入口请用 isViewLockToggleDisabled。
 */
export const isViewMutationMenuDisabled = (
  isTableReadonly: boolean,
  viewLocked: boolean,
): boolean => isTableReadonly || viewLocked

/**
 * 锁定/解锁菜单项：仅表级只读或 busy 时禁用。
 * 视图锁定时必须仍可点「解锁」，否则用户无法解除锁定。
 */
export const isViewLockToggleDisabled = (
  isTableReadonly: boolean,
  isBusy = false,
): boolean => isTableReadonly || isBusy

/**
 * 共享视图配置是否允许写入（筛选/排序/列宽等）。
 * 视图锁定时仅个人视图可改本地草稿；记录单元格编辑不走此函数。
 */
export const isViewConfigMutationAllowed = (
  isTableReadonly: boolean,
  isLocked: unknown,
  isPersonalViewEnabled: boolean,
): boolean => !isTableReadonly && (!isViewLocked(isLocked) || isPersonalViewEnabled)
