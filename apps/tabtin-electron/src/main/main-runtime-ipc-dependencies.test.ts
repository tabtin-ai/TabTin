import { describe, expect, it, vi } from 'vitest'

import { createMainRuntimeIpcDependencies } from './main-runtime-ipc-dependencies'

describe('main-runtime-ipc-dependencies', () => {
  it('会把主窗口运行时映射成 IPC 依赖对象', () => {
    const mainWindowRuntime = {
      windowAppearanceRuntime: {
        getCurrentAppearance: vi.fn(() => 'system'),
        applyAppearance: vi.fn(),
      },
      runtimeServices: {
        getUpdateManager: vi.fn(() => 'update-manager'),
      },
      getPrimaryWindow: vi.fn(() => 'primary-window'),
    }
    const openIMWindow = vi.fn(() => 'im-window')
    const getCapabilityDiscoveryService = vi.fn(() => 'capability-service')

    const dependencies = createMainRuntimeIpcDependencies({
      mainWindowRuntime: mainWindowRuntime as any,
      openIMWindow: openIMWindow as any,
      getCapabilityDiscoveryService,
    })

    expect(dependencies.getUpdateManager()).toBe('update-manager')
    expect(dependencies.getCapabilityDiscoveryService()).toBe('capability-service')
    expect(dependencies.getCurrentAppearance()).toBe('system')
    dependencies.applyAppearance('dark')
    expect(dependencies.getPrimaryWindow()).toBe('primary-window')
    expect(dependencies.openIMWindow()).toBe('im-window')

    expect(mainWindowRuntime.windowAppearanceRuntime.applyAppearance).toHaveBeenCalledWith('dark')
    expect(openIMWindow).toHaveBeenCalledTimes(1)
  })
})
