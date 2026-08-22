import type { BrowserWindow } from 'electron'
import type { MainProcessIpcRegistryDependencies } from './ipc-registry'
import type { MainWindowRuntimeContext } from './main-window-runtime'
import type { CapabilityDiscoveryService } from './services/CapabilityDiscoveryService'

export interface MainRuntimeIpcDependenciesOptions {
  mainWindowRuntime: Pick<
    MainWindowRuntimeContext,
    'windowAppearanceRuntime' | 'runtimeServices' | 'getPrimaryWindow'
  >
  openIMWindow: () => BrowserWindow
  getCapabilityDiscoveryService: () => CapabilityDiscoveryService
}

export function createMainRuntimeIpcDependencies(
  options: MainRuntimeIpcDependenciesOptions,
): MainProcessIpcRegistryDependencies {
  return {
    getUpdateManager: options.mainWindowRuntime.runtimeServices.getUpdateManager,
    getCapabilityDiscoveryService: options.getCapabilityDiscoveryService,
    getCurrentAppearance: options.mainWindowRuntime.windowAppearanceRuntime.getCurrentAppearance,
    getPrimaryWindow: options.mainWindowRuntime.getPrimaryWindow,
    applyAppearance: options.mainWindowRuntime.windowAppearanceRuntime.applyAppearance,
    openIMWindow: options.openIMWindow,
  }
}
