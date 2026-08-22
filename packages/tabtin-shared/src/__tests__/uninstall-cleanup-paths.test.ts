import { describe, it, expect } from 'vitest'
import path from 'node:path'
import {
  TABTIN_USER_DATA_DIR_NAMES,
  CREDENTIALS_FILE_NAME,
  TABTIN_PROTECTED_DIR_NAMES,
  resolveCredentialFilePaths,
  resolveConfigAndCacheWipePaths,
  resolveUpdaterCachePaths,
  resolveMacAppBundlePaths,
  isProtectedWorkspacePath,
  getElectronAppDataRoot,
} from '../uninstall-cleanup-paths.js'

describe('uninstall-cleanup-paths', () => {
  const home = path.resolve('/tmp/tabtin-home')
  const appData = path.join(home, 'AppData', 'Roaming')
  const localCache = path.join(home, 'AppData', 'Local')

  it('lists all profile credential files under appData', () => {
    const files = resolveCredentialFilePaths({ homeDir: home, appDataRoot: appData })
    expect(files).toHaveLength(TABTIN_USER_DATA_DIR_NAMES.length)
    for (const name of TABTIN_USER_DATA_DIR_NAMES) {
      expect(files).toContain(path.join(appData, name, CREDENTIALS_FILE_NAME))
    }
  })

  it('config wipe includes config/cache but never organizations workspace', () => {
    const paths = resolveConfigAndCacheWipePaths({
      homeDir: home,
      appDataRoot: appData,
      localCacheRoot: localCache,
    })
    expect(paths).toContain(path.join(appData, 'TabTin', 'credentials.json'))
    expect(paths).toContain(path.join(appData, 'TabTin', 'device-credential.json'))
    expect(paths).toContain(path.join(appData, 'TabTin', 'app-config.json'))
    expect(paths).toContain(path.join(appData, 'TabTin', 'Partitions'))
    expect(paths).toContain(path.join(home, '.tabtin', 'desktop-approval.json'))
    expect(paths).toContain(path.join(home, '.tabtin-daemon'))
    expect(paths).toContain(path.join(localCache, 'com.tabtin.app-updater'))

    for (const p of paths) {
      expect(p.includes(`${path.sep}organizations`)).toBe(false)
      expect(TABTIN_PROTECTED_DIR_NAMES.every((name) => !p.endsWith(path.sep + name))).toBe(true)
    }
    expect(paths).not.toContain(path.join(appData, 'TabTin'))
  })

  it('isProtectedWorkspacePath guards organizations trees', () => {
    const ws = path.join(appData, 'TabTin', 'organizations', 'org1', 'spaces', 'sp1')
    expect(
      isProtectedWorkspacePath(ws, { homeDir: home, appDataRoot: appData }),
    ).toBe(true)
    expect(
      isProtectedWorkspacePath(path.join(appData, 'TabTin', 'credentials.json'), {
        homeDir: home,
        appDataRoot: appData,
      }),
    ).toBe(false)
  })

  it('updater cache paths sit under local cache root', () => {
    const caches = resolveUpdaterCachePaths({ localCacheRoot: localCache })
    expect(caches[0]).toBe(path.join(localCache, 'com.tabtin.app-updater'))
  })

  it('mac app bundles are under /Applications', () => {
    expect(resolveMacAppBundlePaths()).toContain(
      path.join('/Applications', 'TabTin.app'),
    )
  })

  it('getElectronAppDataRoot respects override', () => {
    expect(getElectronAppDataRoot({ appDataRoot: '/custom/appdata' })).toBe(
      path.resolve('/custom/appdata'),
    )
  })
})
