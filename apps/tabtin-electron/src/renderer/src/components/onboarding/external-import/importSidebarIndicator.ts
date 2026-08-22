/**
 * 任务侧栏「导入数据」指示灯持久化语义：
 * - 每次登录且检测到可导入数据时，最多展示 2 次；
 * - 用户点击侧栏入口后当次会话熄灭；
 * - 完成至少一次导入后永不再亮。
 */

export const IMPORT_DISMISS_STORAGE_KEY = 'tabtin.externalImport.onboarding.dismissed'
export const IMPORT_FORCE_ONBOARDING_STORAGE_KEY = 'tabtin.externalImport.forceOnboarding'
export const IMPORT_SIDEBAR_INDICATOR_STORAGE_KEY = 'tabtin.externalImport.sidebarIndicator.v1'
export const MAX_IMPORT_SIDEBAR_IMPRESSIONS = 2

export interface ImportSidebarIndicatorState {
  loginImpressions: number
  importCompleted: boolean
}

let sessionNavClicked = false

export function resetImportSidebarNavClickedSession(): void {
  sessionNavClicked = false
}

export function markImportSidebarNavClicked(): void {
  sessionNavClicked = true
}

export function isImportSidebarNavClickedThisSession(): boolean {
  return sessionNavClicked
}

export function readImportSidebarIndicatorState(): ImportSidebarIndicatorState {
  try {
    const raw = window.localStorage.getItem(IMPORT_SIDEBAR_INDICATOR_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ImportSidebarIndicatorState>
      return {
        loginImpressions: Math.max(0, Number(parsed.loginImpressions) || 0),
        importCompleted: Boolean(parsed.importCompleted),
      }
    }
    if (window.localStorage.getItem(IMPORT_DISMISS_STORAGE_KEY) === '1') {
      return { loginImpressions: MAX_IMPORT_SIDEBAR_IMPRESSIONS, importCompleted: false }
    }
  } catch {
    /* 隐私模式等 */
  }
  return { loginImpressions: 0, importCompleted: false }
}

export function writeImportSidebarIndicatorState(state: ImportSidebarIndicatorState): void {
  try {
    window.localStorage.setItem(IMPORT_SIDEBAR_INDICATOR_STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* 禁写静默失败 */
  }
}

export function canRegisterImportSidebarImpression(): boolean {
  const state = readImportSidebarIndicatorState()
  return !state.importCompleted && state.loginImpressions < MAX_IMPORT_SIDEBAR_IMPRESSIONS
}

/** 登录后首次 detect 到有数据时调用，返回本次是否允许亮灯。 */
export function registerImportSidebarLoginImpression(): boolean {
  const state = readImportSidebarIndicatorState()
  if (state.importCompleted || state.loginImpressions >= MAX_IMPORT_SIDEBAR_IMPRESSIONS) {
    return false
  }
  writeImportSidebarIndicatorState({
    ...state,
    loginImpressions: state.loginImpressions + 1,
  })
  return true
}

export function markExternalImportCompleted(): void {
  const state = readImportSidebarIndicatorState()
  writeImportSidebarIndicatorState({ ...state, importCompleted: true })
}

/** @deprecated 旧 Banner「不再提示」；映射为已达展示上限。 */
export function persistImportDismissed(): void {
  const state = readImportSidebarIndicatorState()
  writeImportSidebarIndicatorState({
    ...state,
    loginImpressions: MAX_IMPORT_SIDEBAR_IMPRESSIONS,
  })
  try {
    window.localStorage.setItem(IMPORT_DISMISS_STORAGE_KEY, '1')
  } catch {
    /* noop */
  }
}

/**
 * DEV 调试：显式写成 `'1'` 才强制亮灯（方便验收指示灯）。
 * 默认关闭——以前「非 0 即开」会让 dogfood 侧栏小蓝点怎么都灭不掉。
 */
export function isForceImportOnboardingForTest(): boolean {
  if (!import.meta.env.DEV) return false
  try {
    return window.localStorage.getItem(IMPORT_FORCE_ONBOARDING_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** 指示灯是否仍允许亮（已导入完成则永久熄灭）。 */
export function isImportSidebarIndicatorAllowed(): boolean {
  return !readImportSidebarIndicatorState().importCompleted
}
