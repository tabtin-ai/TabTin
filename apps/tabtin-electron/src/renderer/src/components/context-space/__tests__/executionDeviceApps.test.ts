/**
 * 执行设备型 App 白名单测试 —— #1148(APP-29) 遥控器占位的判定源。
 * 锁住「违规应用」清单与 issue 一致,避免后续误增/漏减导致 gate 误伤云应用。
 */
import { describe, it, expect } from 'vitest'
import {
  EXECUTION_DEVICE_APP_IDS,
  EXECUTION_DEVICE_APP_LABEL_FALLBACK,
  isExecutionDeviceApp,
} from '../executionDeviceApps'

describe('EXECUTION_DEVICE_APP_IDS 白名单', () => {
  it('覆盖 #1148 列出的全部执行设备型 App', () => {
    for (const id of ['orchestration', 'tabcode', 'tabfolder', 'terminal', 'tabweb', 'tabdesktop']) {
      expect(isExecutionDeviceApp(id)).toBe(true)
    }
  })

  it('不误伤云应用（tabdata/tabdoc/tabslide 等）', () => {
    for (const id of ['tabdata', 'tabdoc', 'tabslide', 'tabtracker', 'tabsite']) {
      expect(isExecutionDeviceApp(id)).toBe(false)
    }
  })

  it('空值安全', () => {
    expect(isExecutionDeviceApp(null)).toBe(false)
    expect(isExecutionDeviceApp(undefined)).toBe(false)
    expect(isExecutionDeviceApp('')).toBe(false)
  })

  it('每个白名单成员都有 banner 文案兜底', () => {
    for (const id of EXECUTION_DEVICE_APP_IDS) {
      expect(EXECUTION_DEVICE_APP_LABEL_FALLBACK[id]).toBeTruthy()
    }
  })
})
