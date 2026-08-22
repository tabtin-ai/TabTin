import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  IMPORT_FORCE_ONBOARDING_STORAGE_KEY,
  IMPORT_SIDEBAR_INDICATOR_STORAGE_KEY,
  MAX_IMPORT_SIDEBAR_IMPRESSIONS,
  isForceImportOnboardingForTest,
  isImportSidebarIndicatorAllowed,
  markExternalImportCompleted,
  markImportSidebarNavClicked,
  readImportSidebarIndicatorState,
  registerImportSidebarLoginImpression,
  resetImportSidebarNavClickedSession,
} from './importSidebarIndicator'

describe('importSidebarIndicator', () => {
  beforeEach(() => {
    window.localStorage.clear()
    resetImportSidebarNavClickedSession()
  })

  it('首次登录 detect 后可亮灯，点击后当次会话熄灭', () => {
    expect(registerImportSidebarLoginImpression()).toBe(true)
    expect(readImportSidebarIndicatorState().loginImpressions).toBe(1)

    markImportSidebarNavClicked()
    // 会话内点击状态由模块内 flag 维护
    resetImportSidebarNavClickedSession()
    expect(registerImportSidebarLoginImpression()).toBe(true)
    expect(readImportSidebarIndicatorState().loginImpressions).toBe(2)
  })

  it('最多亮两次，第三次登录不再登记', () => {
    expect(registerImportSidebarLoginImpression()).toBe(true)
    resetImportSidebarNavClickedSession()
    expect(registerImportSidebarLoginImpression()).toBe(true)
    resetImportSidebarNavClickedSession()
    expect(registerImportSidebarLoginImpression()).toBe(false)
    expect(readImportSidebarIndicatorState().loginImpressions).toBe(MAX_IMPORT_SIDEBAR_IMPRESSIONS)
  })

  it('完成导入后永不再登记', () => {
    markExternalImportCompleted()
    expect(registerImportSidebarLoginImpression()).toBe(false)
    expect(isImportSidebarIndicatorAllowed()).toBe(false)
    const raw = window.localStorage.getItem(IMPORT_SIDEBAR_INDICATOR_STORAGE_KEY)
    expect(raw).toContain('"importCompleted":true')
  })

  it('DEV forceOnboarding 默认关闭，仅显式 1 才开', () => {
    expect(isForceImportOnboardingForTest()).toBe(false)
    window.localStorage.setItem(IMPORT_FORCE_ONBOARDING_STORAGE_KEY, '1')
    expect(isForceImportOnboardingForTest()).toBe(true)
    window.localStorage.setItem(IMPORT_FORCE_ONBOARDING_STORAGE_KEY, '0')
    expect(isForceImportOnboardingForTest()).toBe(false)
  })
})
