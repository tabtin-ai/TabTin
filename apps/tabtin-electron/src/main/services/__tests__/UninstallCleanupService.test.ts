import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenManager } from '../../auth'
import { join } from 'node:path'
import {
  classifyWipeErrorCode,
  clearPendingLocalDataWipeMarker,
  hasPendingLocalDataWipe,
  resolveLocalDataWipePaths,
  setUninstallCleanupBeforeWipeHook,
  uninstallDesktopApp,
  wipeAllLocalData,
  wipeLoginCredentials,
  writePendingLocalDataWipeMarker,
  PENDING_LOCAL_DATA_WIPE_FILE,
} from '../UninstallCleanupService'

const { rmMock, existsSyncMock, writeFileSyncMock, mkdirSyncMock, rmSyncMock, markerFiles } =
  vi.hoisted(() => {
    const markerFiles = new Map<string, string>()
    return {
      markerFiles,
      rmMock: vi.fn(),
      existsSyncMock: vi.fn((target: unknown) => {
        const key = String(target)
        if (markerFiles.has(key)) return true
        return true
      }),
      writeFileSyncMock: vi.fn((target: unknown, data: unknown) => {
        markerFiles.set(String(target), String(data))
      }),
      mkdirSyncMock: vi.fn(),
      rmSyncMock: vi.fn((target: unknown) => {
        markerFiles.delete(String(target))
      }),
    }
  })

// jsdom 下勿用 importOriginal mock node:fs*（会落到 browser-external 路径）
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  writeFileSync: writeFileSyncMock,
  mkdirSync: mkdirSyncMock,
  rmSync: rmSyncMock,
  readFileSync: (target: unknown) => {
    const key = String(target)
    if (!markerFiles.has(key)) throw new Error(`ENOENT: ${key}`)
    return markerFiles.get(key)
  },
  default: {
    existsSync: existsSyncMock,
    writeFileSync: writeFileSyncMock,
    mkdirSync: mkdirSyncMock,
    rmSync: rmSyncMock,
  },
}))

vi.mock('node:fs/promises', () => ({
  rm: rmMock,
  default: {
    rm: rmMock,
  },
}))

vi.mock('@tabtin/shared', () => ({
  isProtectedWorkspacePath: vi.fn(() => false),
  resolveConfigAndCacheWipePaths: vi.fn(() => [
    'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\credentials.json',
    'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\app-config.json',
    'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\Local Storage\\leveldb',
  ]),
  resolveCredentialFilePaths: vi.fn(() => [
    'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\credentials.json',
  ]),
  TABTIN_CONFIG_FILE_RELATIVE_PATHS: ['credentials.json', 'app-config.json'],
  TABTIN_CONFIG_DIR_RELATIVE_PATHS: ['Cache', 'Local Storage'],
  TABTIN_HOME_CONFIG_FILE_RELATIVE_PATHS: ['desktop-approval.json'],
  resolveUpdaterCachePaths: vi.fn(() => ['C:\\Users\\tester\\AppData\\Local\\TabTin-updater']),
}))

vi.mock('../../auth', () => ({
  TokenManager: {
    clearAuthData: vi.fn(),
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../../utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
}))

// 默认无可用 session：未注入 beforeWipeHook 时不会误判「已预清」而软跳过 busy
vi.mock('electron', () => ({
  session: {
    defaultSession: null,
  },
  app: {
    getPath: () => 'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod',
    isPackaged: false,
  },
}))

const clearAuthDataMock = vi.mocked(TokenManager.clearAuthData)

describe('UninstallCleanupService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    markerFiles.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    existsSyncMock.mockImplementation((target: unknown) => {
      const key = String(target)
      if (key.toLowerCase().endsWith(PENDING_LOCAL_DATA_WIPE_FILE.toLowerCase())) {
        return markerFiles.has(key)
      }
      return true
    })
    clearAuthDataMock.mockResolvedValue(undefined as never)
    setUninstallCleanupBeforeWipeHook(null)
  })

  afterEach(() => {
    setUninstallCleanupBeforeWipeHook(null)
    vi.useRealTimers()
    markerFiles.clear()
  })

  it('pending wipe 标记可写可读可清', () => {
    const dir = 'C:\\Users\\tester\\AppData\\Roaming\\TabTin Local-feature-test'
    const flag = join(dir, PENDING_LOCAL_DATA_WIPE_FILE)
    expect(hasPendingLocalDataWipe(dir)).toBe(false)
    writePendingLocalDataWipeMarker(dir)
    expect(writeFileSyncMock).toHaveBeenCalled()
    expect(hasPendingLocalDataWipe(dir)).toBe(true)
    expect(JSON.parse(markerFiles.get(flag) || '{}').version).toBe(1)
    clearPendingLocalDataWipeMarker(dir)
    expect(hasPendingLocalDataWipe(dir)).toBe(false)
    expect(markerFiles.has(flag)).toBe(false)
  })

  it('resolveLocalDataWipePaths(current) 只含当前实例，不含其它 profile', () => {
    const current = 'C:\\Users\\tester\\AppData\\Roaming\\TabTin Local-feature-7395'
    const paths = resolveLocalDataWipePaths(current, 'current')
    expect(paths).toContain(join(current, 'Cache'))
    expect(paths).toContain(join(current, 'credentials.json'))
    expect(paths.some((p) => p.includes('TabTin Preprod'))).toBe(false)
    expect(paths.some((p) => p.toLowerCase().endsWith(PENDING_LOCAL_DATA_WIPE_FILE))).toBe(false)
  })

  it('classifyWipeErrorCode 映射稳定码', () => {
    expect(classifyWipeErrorCode(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe('busy')
    expect(classifyWipeErrorCode(new Error('ENOTEMPTY: directory not empty'))).toBe('busy')
    expect(classifyWipeErrorCode(Object.assign(new Error('denied'), { code: 'EPERM' }))).toBe(
      'permission',
    )
    expect(classifyWipeErrorCode(new Error('keychain unavailable'))).toBe('unknown')
  })

  it('清除本地配置与缓存遇到占用文件失败时不清登录态，且返回 busy', async () => {
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('Local Storage')) {
        throw new Error('EBUSY: resource busy or locked, unlink')
      }
    })

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(false)
    expect(result.credentialsCleared).toBe(false)
    expect(result.failed.some((item) => item.errorCode === 'busy')).toBe(true)
    expect(JSON.stringify(result.failed)).not.toMatch(/EBUSY/)
    expect(clearAuthDataMock).not.toHaveBeenCalled()
    expect(rmMock).not.toHaveBeenCalledWith(
      'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\credentials.json',
      expect.anything(),
    )
  })

  it('清除本地配置与缓存遇到 EPERM 时保留登录态，且返回 permission', async () => {
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('app-config.json')) {
        throw new Error('EPERM: operation not permitted, unlink')
      }
    })

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(false)
    expect(result.credentialsCleared).toBe(false)
    expect(result.failed.some((item) => item.errorCode === 'permission')).toBe(true)
    expect(JSON.stringify(result.failed)).not.toMatch(/EPERM/)
    expect(clearAuthDataMock).not.toHaveBeenCalled()
  })

  it('占用文件经重试后删除成功则继续清登录态', async () => {
    let localStorageAttempts = 0
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('Local Storage')) {
        localStorageAttempts += 1
        if (localStorageAttempts < 3) {
          throw new Error('EBUSY: resource busy or locked, unlink')
        }
      }
    })

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(true)
    expect(result.credentialsCleared).toBe(true)
    expect(localStorageAttempts).toBe(3)
    expect(clearAuthDataMock).toHaveBeenCalledWith({ rethrow: true })
  })

  it('清除本地配置与缓存成功后才清登录态', async () => {
    rmMock.mockResolvedValue(undefined)

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(true)
    expect(result.credentialsCleared).toBe(true)
    expect(clearAuthDataMock).toHaveBeenCalledWith({ rethrow: true })
    expect(rmMock).toHaveBeenCalledWith(
      'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\credentials.json',
      expect.objectContaining({ recursive: false, force: true }),
    )
  })

  it('wipe 前 hook 会被调用，hook 失败不阻断磁盘清理', async () => {
    const beforeWipe = vi.fn(async () => {
      throw new Error('session unavailable')
    })
    setUninstallCleanupBeforeWipeHook(beforeWipe)
    rmMock.mockResolvedValue(undefined)

    const result = await wipeAllLocalData()

    expect(beforeWipe).toHaveBeenCalledTimes(1)
    expect(result.ok).toBe(true)
    expect(result.credentialsCleared).toBe(true)
  })

  it('清除 auth 缓存失败时返回失败结果（unknown）', async () => {
    rmMock.mockResolvedValue(undefined)
    clearAuthDataMock.mockRejectedValueOnce(new Error('keychain unavailable'))

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(false)
    expect(result.credentialsCleared).toBe(false)
    expect(result.failed).toContainEqual({
      path: 'auth-cache',
      errorCode: 'unknown',
    })
    expect(rmMock).toHaveBeenCalledWith(
      'C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\credentials.json',
      expect.objectContaining({ recursive: false, force: true }),
    )
  })

  it('磁盘凭证删除失败时不清 auth 缓存', async () => {
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('credentials.json')) {
        throw new Error('EPERM: operation not permitted, unlink')
      }
    })

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(false)
    expect(result.credentialsCleared).toBe(false)
    expect(result.failed.some((item) => item.errorCode === 'permission')).toBe(true)
    expect(clearAuthDataMock).not.toHaveBeenCalled()
  })

  it('配置部分已删但后续缓存失败时硬失败且保留登录态', async () => {
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('Local Storage')) {
        throw new Error('ENOTEMPTY: directory not empty')
      }
    })

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(false)
    expect(result.removed).toContain('C:\\Users\\tester\\AppData\\Roaming\\TabTin Preprod\\app-config.json')
    expect(result.failed.some((item) => item.errorCode === 'busy')).toBe(true)
    expect(result.credentialsCleared).toBe(false)
    expect(clearAuthDataMock).not.toHaveBeenCalled()
  })

  it('session 预清成功后 Chromium 目录 busy 不挡清凭证', async () => {
    setUninstallCleanupBeforeWipeHook(async () => {
      // 模拟 clearStorageData 已成功
    })
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('Local Storage')) {
        throw new Error('EBUSY: resource busy or locked, unlink')
      }
    })

    const result = await wipeAllLocalData()

    expect(result.ok).toBe(true)
    expect(result.credentialsCleared).toBe(true)
    expect(result.failed).toEqual([])
    expect(clearAuthDataMock).toHaveBeenCalledWith({ rethrow: true })
  })

  it('卸载前勾选本地数据清理失败时不提前清登录态', async () => {
    rmMock.mockImplementation(async (target: unknown) => {
      if (String(target).includes('Local Storage')) {
        throw new Error('EBUSY: resource busy or locked, unlink')
      }
    })

    const result = await uninstallDesktopApp({ deleteLocalData: true })

    expect(result.ok).toBe(false)
    expect(result.credentials.credentialsCleared).toBe(false)
    expect(result.localData?.credentialsCleared).toBe(false)
    expect(result.credentials.failed[0]?.errorCode).toBe('unknown')
    expect(clearAuthDataMock).not.toHaveBeenCalled()
  })

  it('单独清登录凭证遇到磁盘凭证失败时不清 auth 缓存', async () => {
    rmMock.mockRejectedValue(new Error('EBUSY: resource busy or locked, unlink'))

    const result = await wipeLoginCredentials()

    expect(result.ok).toBe(false)
    expect(result.credentialsCleared).toBe(false)
    expect(result.failed[0]?.errorCode).toBe('busy')
    expect(clearAuthDataMock).not.toHaveBeenCalled()
  })

  it('单独清登录凭证成功时清 auth 缓存', async () => {
    rmMock.mockResolvedValue(undefined)

    const result = await wipeLoginCredentials()

    expect(result.ok).toBe(true)
    expect(result.credentialsCleared).toBe(true)
    expect(clearAuthDataMock).toHaveBeenCalledWith({ rethrow: true })
  })
})
