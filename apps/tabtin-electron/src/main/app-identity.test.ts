import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  is: { dev: false },
  app: {
    isPackaged: false,
    getName: vi.fn(() => 'tabtin-electron'),
    getAppPath: vi.fn(() => '/tmp/tabtin-app'),
    setName: vi.fn(),
    getPath: vi.fn((name: string) => {
      if (name === 'appData') return '/Users/test/Library/Application Support'
      return `/tmp/${name}`
    }),
    setPath: vi.fn(),
  },
  readFileSync: vi.fn(() => {
    throw new Error('no packaged metadata')
  }),
}))

vi.mock('electron', () => ({
  app: mocks.app,
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: mocks.is,
}))

vi.mock('node:fs', () => ({
  default: {
    readFileSync: mocks.readFileSync,
  },
  readFileSync: mocks.readFileSync,
}))

import {
  applyRuntimeAppIdentity,
  resolveDefaultWorkspaceDirectoryName,
  resolvePackagedRuntimeProfileFromHost,
  resolveIsDevRuntime,
  resolveRuntimeAppIdentity,
} from './app-identity'

describe('app-identity', () => {
  const originalRuntimeProfile = process.env.TABTIN_RUNTIME_PROFILE
  const originalViteBuildProfile = process.env.VITE_BUILD_PROFILE
  const originalBuildProfile = process.env.TABTIN_BUILD_PROFILE
  const originalAppId = process.env.TABTIN_APP_ID
  const originalProductName = process.env.TABTIN_APP_PRODUCT_NAME
  const originalDataRoot = process.env.TABTIN_DATA_ROOT
  const originalRuntimeRoot = process.env.TABTIN_RUNTIME_ROOT
  const originalConfigDir = process.env.TABTIN_CONFIG_DIR
  const originalDevInstance = process.env.TABTIN_DEV_INSTANCE
  const originalResourcesPath = process.resourcesPath

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.is.dev = false
    mocks.app.isPackaged = false
    mocks.app.getName.mockReturnValue('tabtin-electron')
    mocks.app.getAppPath.mockReturnValue('/tmp/tabtin-app')
    mocks.readFileSync.mockImplementation(() => {
      throw new Error('no packaged metadata')
    })
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: undefined,
    })
    delete process.env.TABTIN_RUNTIME_PROFILE
    delete process.env.VITE_BUILD_PROFILE
    delete process.env.TABTIN_BUILD_PROFILE
    delete process.env.TABTIN_APP_ID
    delete process.env.TABTIN_APP_PRODUCT_NAME
    delete process.env.TABTIN_DATA_ROOT
    delete process.env.TABTIN_RUNTIME_ROOT
    delete process.env.TABTIN_CONFIG_DIR
    delete process.env.TABTIN_DEV_INSTANCE
  })

  afterEach(() => {
    restoreEnv('TABTIN_RUNTIME_PROFILE', originalRuntimeProfile)
    restoreEnv('VITE_BUILD_PROFILE', originalViteBuildProfile)
    restoreEnv('TABTIN_BUILD_PROFILE', originalBuildProfile)
    restoreEnv('TABTIN_APP_ID', originalAppId)
    restoreEnv('TABTIN_APP_PRODUCT_NAME', originalProductName)
    restoreEnv('TABTIN_DATA_ROOT', originalDataRoot)
    restoreEnv('TABTIN_RUNTIME_ROOT', originalRuntimeRoot)
    restoreEnv('TABTIN_CONFIG_DIR', originalConfigDir)
    restoreEnv('TABTIN_DEV_INSTANCE', originalDevInstance)
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: originalResourcesPath,
    })
  })

  it('development runtime uses a dedicated dev identity and userData path', () => {
    const identity = applyRuntimeAppIdentity()

    expect(identity).toMatchObject({
      profile: 'development',
      appId: 'com.tabtin.app.dev',
      productName: 'TabTin Dev',
    })
    expect(mocks.app.setName).toHaveBeenCalledWith('TabTin Dev')
    expect(mocks.app.setPath).toHaveBeenCalledWith(
      'userData',
      join('/Users/test/Library/Application Support', 'TabTin Dev'),
    )
    expect(process.env.TABTIN_APP_ID).toBe('com.tabtin.app.dev')
    expect(process.env.TABTIN_DATA_ROOT).toBe(
      join('/Users/test/Library/Application Support', 'TabTin Dev'),
    )
    expect(process.env.TABTIN_RUNTIME_ROOT).toBe(
      join('/Users/test/Library/Application Support', 'TabTin Dev', 'runtime'),
    )
    expect(process.env.TABTIN_CONFIG_DIR).toBe(process.env.TABTIN_RUNTIME_ROOT)
  })

  it('development secondary instance gets an isolated userData directory', () => {
    process.env.TABTIN_DEV_INSTANCE = 'im-2'

    applyRuntimeAppIdentity()

    expect(mocks.app.setName).toHaveBeenCalledWith('TabTin Dev (im-2)')
    expect(mocks.app.setPath).toHaveBeenCalledWith(
      'userData',
      join('/Users/test/Library/Application Support', 'TabTin Dev-im-2'),
    )
  })

  it('packaged preprod runtime is inferred from the packaged app name', () => {
    mocks.app.isPackaged = true
    mocks.app.getName.mockReturnValue('TabTin Preprod')

    expect(resolveRuntimeAppIdentity()).toMatchObject({
      profile: 'preprod',
      appId: 'com.tabtin.app.preprod',
      productName: 'TabTin Preprod',
    })
  })

  it('packaged preprod runtime is inferred from packaged metadata when app name is shared', () => {
    mocks.app.isPackaged = true
    mocks.app.getName.mockReturnValue('TabTin')
    mocks.app.getAppPath.mockReturnValue('/tmp/tabtin-preprod-app')
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      build: {
        extraMetadata: {
          tabtinDesktop: {
            buildProfile: 'preprod',
          },
        },
      },
    }))

    expect(resolveRuntimeAppIdentity()).toMatchObject({
      profile: 'preprod',
      appId: 'com.tabtin.app.preprod',
      productName: 'TabTin Preprod',
    })
  })

  it('packaged community runtime keeps an isolated identity and userData path', () => {
    mocks.app.isPackaged = true
    mocks.app.getName.mockReturnValue('TabTin Community')
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      build: {
        extraMetadata: {
          tabtinDesktop: {
            buildProfile: 'community',
          },
        },
      },
    }))

    expect(applyRuntimeAppIdentity()).toMatchObject({
      profile: 'community',
      appId: 'com.tabtin.community',
      productName: 'TabTin Community',
    })
    expect(mocks.app.setPath).toHaveBeenCalledWith(
      'userData',
      join('/Users/test/Library/Application Support', 'TabTin Community'),
    )
  })

  it('packaged preprod runtime is inferred from the app bundle resources path', () => {
    mocks.app.isPackaged = true
    mocks.app.getName.mockReturnValue('TabTin')
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/Applications/TabTin Preprod.app/Contents/Resources',
    })

    expect(resolvePackagedRuntimeProfileFromHost()).toBe('preprod')
    expect(resolveRuntimeAppIdentity()).toMatchObject({
      profile: 'preprod',
      appId: 'com.tabtin.app.preprod',
      productName: 'TabTin Preprod',
    })
  })

  it('explicit local profile overrides packaged app name inference', () => {
    mocks.app.isPackaged = true
    mocks.app.getName.mockReturnValue('TabTin Preprod')
    process.env.TABTIN_RUNTIME_PROFILE = 'local'

    expect(resolveRuntimeAppIdentity()).toMatchObject({
      profile: 'local',
      appId: 'com.tabtin.app.local',
      productName: 'TabTin Local',
    })
  })

  it('packaged runtime defaults to production when no profile marker exists', () => {
    mocks.app.isPackaged = true
    mocks.app.getName.mockReturnValue('TabTin')
    delete process.env.TABTIN_RUNTIME_PROFILE
    delete process.env.VITE_BUILD_PROFILE
    delete process.env.TABTIN_BUILD_PROFILE

    expect(resolveRuntimeAppIdentity()).toMatchObject({
      profile: 'production',
      appId: 'com.tabtin.app',
      productName: 'TabTin',
    })
  })

  it('treats only packaged local as dev-like in packaged mode', () => {
    mocks.app.isPackaged = true

    for (const profile of ['community', 'preprod', 'production'] as const) {
      process.env.TABTIN_RUNTIME_PROFILE = profile
      expect(resolveIsDevRuntime()).toBe(false)
    }

    process.env.TABTIN_RUNTIME_PROFILE = 'local'
    expect(resolveIsDevRuntime()).toBe(true)
  })

  it('keeps unpackaged and toolkit dev launches dev-like', () => {
    process.env.TABTIN_RUNTIME_PROFILE = 'production'
    expect(resolveIsDevRuntime()).toBe(true)

    mocks.app.isPackaged = true
    mocks.is.dev = true
    expect(resolveIsDevRuntime()).toBe(true)
  })

  it('keeps every runtime profile in a distinct macOS Safe Storage namespace', () => {
    const profiles = ['development', 'local', 'community', 'preprod', 'production'] as const
    const safeStorageNames = profiles.map((profile) => {
      process.env.TABTIN_RUNTIME_PROFILE = profile
      return `${resolveRuntimeAppIdentity().productName} Safe Storage`
    })

    expect(new Set(safeStorageNames).size).toBe(profiles.length)

    process.env.TABTIN_RUNTIME_PROFILE = 'preprod'
    applyRuntimeAppIdentity()
    expect(mocks.app.setName).toHaveBeenLastCalledWith('TabTin Preprod')
  })

  it('keeps production default Workspace root compatible while isolating other profiles', () => {
    expect(resolveDefaultWorkspaceDirectoryName('production')).toBe('TabTin')
    expect(resolveDefaultWorkspaceDirectoryName('community')).toBe('TabTin Community')
    expect(resolveDefaultWorkspaceDirectoryName('preprod')).toBe('TabTin Preprod')
    expect(resolveDefaultWorkspaceDirectoryName('development')).toBe('TabTin Dev')
    expect(resolveDefaultWorkspaceDirectoryName('local')).toBe('TabTin Local')
  })
})

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}
