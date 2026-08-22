import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  dialog: { showMessageBox: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: {
    getFocusedWindow: () => undefined,
    getAllWindows: () => [],
  },
}))

vi.mock('../app-relaunch-registry.js', () => ({
  getAppBeforeRelaunch: () => undefined,
}))

const {
  osErrorRequiresAppRelaunch,
  pickOsPermissionSettingsLink,
  promptOsPermissionHostRelaunch,
  resetOsPermissionRelaunchPromptForTests,
} = await import('../os-permission-host-relaunch.js')

describe('os-permission-host-relaunch', () => {
  beforeEach(() => {
    resetOsPermissionRelaunchPromptForTests()
  })

  it('只有 restart_app 恢复动作才需要宿主重启入口', () => {
    expect(osErrorRequiresAppRelaunch({
      recoveryActions: [{ type: 'open_system_settings', deepLink: 'x-apple.systempreferences:com.apple.preference.security' }],
    })).toBe(false)
    expect(osErrorRequiresAppRelaunch({
      recoveryActions: [{ type: 'restart_app', label: '重启 TabTin' }],
    })).toBe(true)
  })

  it('打开系统设置走 deepLink，不重启', async () => {
    const openExternal = vi.fn(async () => undefined)
    const result = await promptOsPermissionHostRelaunch(
      {
        recoveryActions: [
          { type: 'open_system_settings', deepLink: 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles' },
          { type: 'restart_app', label: '重启 TabTin' },
        ],
      },
      {
        showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
        openExternal,
      },
    )
    expect(result).toBe('opened_settings')
    expect(openExternal).toHaveBeenCalledOnce()
  })

  it('用户确认后走 beforeRelaunch + relaunchApp', async () => {
    const beforeRelaunch = vi.fn(async () => undefined)
    const relaunchApp = vi.fn(async () => undefined)
    const result = await promptOsPermissionHostRelaunch(
      { recoveryActions: [{ type: 'restart_app' }] },
      {
        showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
        beforeRelaunch,
        relaunchApp,
      },
    )
    expect(result).toBe('restarting')
    expect(beforeRelaunch).toHaveBeenCalledOnce()
    expect(relaunchApp).toHaveBeenCalledOnce()
  })

  it('用户取消重启前确认则中止', async () => {
    const result = await promptOsPermissionHostRelaunch(
      { recoveryActions: [{ type: 'restart_app' }] },
      {
        showMessageBox: async () => ({ response: 1, checkboxChecked: false }),
        beforeRelaunch: async () => {
          throw new Error('relaunch_aborted_by_user')
        },
        relaunchApp: async () => {
          throw new Error('should not relaunch')
        },
      },
    )
    expect(result).toBe('aborted')
  })
})
