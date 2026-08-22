import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

let appDataRoot = ''
let currentUserDataDirName = 'TabTin Dev'
let runtimeProfile: 'development' | 'local' | 'preprod' | 'production' = 'development'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'appData') return appDataRoot
      if (name === 'userData') return path.join(appDataRoot, currentUserDataDirName)
      return os.tmpdir()
    },
    isPackaged: false,
  },
}))

vi.mock('../../app-identity', async () => {
  const actual = await vi.importActual<typeof import('../../app-identity')>('../../app-identity')
  return { ...actual, resolveRuntimeProfile: () => runtimeProfile }
})

const machineIdState = vi.hoisted(() => ({ raw: null as string | null }))
vi.mock('../machineId', () => ({
  getRawMachineId: () => machineIdState.raw,
  _resetRawMachineIdCacheForTests: () => {},
}))

import {
  getDeviceFingerprint,
  getDeviceIdentity,
  nextDeviceRuntimeProfileRevision,
  persistDeviceRuntimeProfileRevision,
  _resetDeviceFingerprintCacheForTests,
} from '../deviceFingerprint'

const FILE_NAME = 'device-fingerprint.json'

function writeIdentity(dirName: string, identity: Record<string, unknown>): void {
  const dir = path.join(appDataRoot, dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, FILE_NAME), JSON.stringify(identity))
}

function readIdentity(dirName: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(appDataRoot, dirName, FILE_NAME), 'utf-8'))
}

describe('getDeviceIdentity（安装身份与重装恢复）', () => {
  beforeEach(() => {
    appDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-appdata-'))
    currentUserDataDirName = 'TabTin Dev'
    runtimeProfile = 'development'
    machineIdState.raw = 'MACHINE-UUID-TEST'
    _resetDeviceFingerprintCacheForTests()
  })

  afterEach(() => {
    try { fs.rmSync(appDataRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('首次安装生成 UUID，后续更新即使可读取硬件标识也不改变 fingerprint', () => {
    const first = getDeviceIdentity()
    expect(first.fingerprint).toMatch(/^electron-[0-9a-f-]{36}$/)
    expect(first.machineKey).toHaveLength(32)

    _resetDeviceFingerprintCacheForTests()
    expect(getDeviceIdentity().fingerprint).toBe(first.fingerprint)
    expect(readIdentity('TabTin Dev').fingerprint).toBe(first.fingerprint)
  })

  it('已有历史随机 fingerprint 不会被硬件哈希覆盖', () => {
    writeIdentity('TabTin Dev', { fingerprint: 'electron-legacy-install-id' })

    const identity = getDeviceIdentity()

    expect(identity.fingerprint).toBe('electron-legacy-install-id')
    expect(identity.machineKey).toHaveLength(32)
    expect(readIdentity('TabTin Dev').fingerprint).toBe('electron-legacy-install-id')
  })

  it('删除 userData 后是新安装身份，但同 profile machineKey 保持不变供服务端恢复', () => {
    const first = getDeviceIdentity()
    fs.rmSync(path.join(appDataRoot, 'TabTin Dev'), { recursive: true, force: true })
    _resetDeviceFingerprintCacheForTests()

    const reinstalled = getDeviceIdentity()

    expect(reinstalled.fingerprint).not.toBe(first.fingerprint)
    expect(reinstalled.machineKey).toBe(first.machineKey)
  })

  it('不同 profile 使用不同安装身份和 machineKey', () => {
    const dev = getDeviceIdentity()
    _resetDeviceFingerprintCacheForTests()
    runtimeProfile = 'production'
    currentUserDataDirName = 'TabTin'

    const prod = getDeviceIdentity()

    expect(prod.fingerprint).not.toBe(dev.fingerprint)
    expect(prod.machineKey).not.toBe(dev.machineKey)
  })

  it('不从其它 profile 收集历史候选', () => {
    writeIdentity('TabTin Preprod', { fingerprint: 'electron-current-preprod' })
    writeIdentity('TabTin', {
      fingerprint: 'electron-current-production',
      previous_fingerprint: 'electron-production-legacy',
    })
    writeIdentity('tabtin-electron', { fingerprint: 'electron-legacy-default' })
    runtimeProfile = 'preprod'
    currentUserDataDirName = 'TabTin Preprod'

    const identity = getDeviceIdentity()

    expect(identity.previousFingerprint).toBeNull()
    expect(identity.recoveryFingerprints).toEqual([])
  })

  it('production 可将旧共享目录身份作为当前档历史身份', () => {
    writeIdentity('tabtin-electron', { fingerprint: 'electron-legacy-default' })
    runtimeProfile = 'production'
    currentUserDataDirName = 'TabTin'

    const identity = getDeviceIdentity()

    expect(identity.previousFingerprint).toBe('electron-legacy-default')
    expect(identity.recoveryFingerprints).toEqual([])
  })

  it('硬件标识不可读时仍生成并持久化安装身份', () => {
    machineIdState.raw = null
    const fingerprint = getDeviceFingerprint()
    expect(fingerprint).toMatch(/^electron-[0-9a-f-]{36}$/)
    expect(getDeviceIdentity().machineKey).toBeNull()
  })

  it('运行资料 revision 取服务端与本地较大值并只向前持久化', () => {
    getDeviceIdentity()

    expect(nextDeviceRuntimeProfileRevision(5)).toBe(6)
    persistDeviceRuntimeProfileRevision(6)
    expect(nextDeviceRuntimeProfileRevision(3)).toBe(7)

    persistDeviceRuntimeProfileRevision(4)
    expect(readIdentity('TabTin Dev').runtime_profile_revision).toBe(6)
  })
})
