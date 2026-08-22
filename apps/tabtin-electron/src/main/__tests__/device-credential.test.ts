import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  userData: '',
  encryptionAvailable: true,
  decryptFails: false,
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encryptionAvailable,
    encryptString: (plain: string) => Buffer.from([...Buffer.from(plain)].reverse()),
    decryptString: (encrypted: Buffer) => {
      if (state.decryptFails) throw new Error('keychain unavailable')
      return Buffer.from([...encrypted].reverse()).toString('utf8')
    },
  },
}))

vi.mock('../logger', () => ({
  createLogger: () => ({
    warn: state.warn,
    debug: state.debug,
    info: state.info,
    error: vi.fn(),
  }),
}))

describe('Electron 设备凭据', () => {
  beforeEach(() => {
    vi.resetModules()
    state.userData = mkdtempSync(join(tmpdir(), 'tabtin-device-credential-'))
    state.encryptionAvailable = true
    state.decryptFails = false
    state.warn.mockClear()
    state.debug.mockClear()
    state.info.mockClear()
  })

  afterEach(() => {
    rmSync(state.userData, { recursive: true, force: true })
  })

  it('按 installation_id 稳定复用 32-byte 密钥且仅落密文', async () => {
    const { getOrCreateDeviceCredential } = await import('../device-credential')

    const first = await getOrCreateDeviceCredential('installation-a')
    const reused = await getOrCreateDeviceCredential('installation-a')
    const other = await getOrCreateDeviceCredential('installation-b')

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(first!, 'base64url')).toHaveLength(32)
    expect(reused).toBe(first)
    expect(other).not.toBe(first)

    const persisted = readFileSync(join(state.userData, 'device-credential.json'), 'utf8')
    expect(persisted).toContain('enc:')
    expect(persisted).not.toContain(first!)
    expect(JSON.stringify([
      ...state.warn.mock.calls,
      ...state.debug.mock.calls,
      ...state.info.mock.calls,
    ])).not.toContain(first!)
  })

  it('safeStorage 不可用时不生成凭据且不落盘', async () => {
    state.encryptionAvailable = false
    const { getOrCreateDeviceCredential } = await import('../device-credential')

    await expect(getOrCreateDeviceCredential('installation-a')).resolves.toBeNull()
    expect(existsSync(join(state.userData, 'device-credential.json'))).toBe(false)
  })

  it('已有密文无法解密时不生成新凭据覆盖原文件', async () => {
    const { getOrCreateDeviceCredential } = await import('../device-credential')
    const original = await getOrCreateDeviceCredential('installation-a')
    const credentialPath = join(state.userData, 'device-credential.json')
    const persisted = readFileSync(credentialPath, 'utf8')

    vi.resetModules()
    state.decryptFails = true
    const reloaded = await import('../device-credential')

    await expect(reloaded.getOrCreateDeviceCredential('installation-a')).resolves.toBeNull()
    expect(readFileSync(credentialPath, 'utf8')).toBe(persisted)
    expect(persisted).not.toContain(original!)
  })

  it('已有密文解出非法值时不静默轮换', async () => {
    const { getOrCreateDeviceCredential } = await import('../device-credential')
    await getOrCreateDeviceCredential('installation-a')
    const credentialPath = join(state.userData, 'device-credential.json')
    const malformed = Buffer.from([...Buffer.from('too-short')].reverse()).toString('base64')
    const persisted = JSON.stringify({
      installation_id: 'installation-a',
      credential: `enc:${malformed}`,
    })
    writeFileSync(credentialPath, persisted)

    vi.resetModules()
    const reloaded = await import('../device-credential')

    await expect(reloaded.getOrCreateDeviceCredential('installation-a')).resolves.toBeNull()
    expect(readFileSync(credentialPath, 'utf8')).toBe(persisted)
  })
})
