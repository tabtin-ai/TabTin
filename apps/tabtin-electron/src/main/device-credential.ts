import { app, safeStorage } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '@tabtin/terminal-core'
import { createLogger } from './logger'

const log = createLogger('DeviceCredential')
const FILE_NAME = 'device-credential.json'
const inFlight = new Map<string, Promise<string | null>>()

interface StoredDeviceCredential {
  installation_id: string
  credential: string
}

function isValidDeviceCredential(value: string | null): value is string {
  return value != null
    && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').length === 32
}

function credentialPath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return join(dir, FILE_NAME)
}

function readStoredCredential(path: string, installationId: string): string | null {
  const stored = JSON.parse(readFileSync(path, 'utf8')) as StoredDeviceCredential
  if (stored.installation_id !== installationId || !stored.credential?.startsWith('enc:')) {
    throw new Error('device credential identity mismatch')
  }
  const value = safeStorage.decryptString(Buffer.from(stored.credential.slice(4), 'base64'))
  if (!isValidDeviceCredential(value)) throw new Error('invalid device credential')
  return value
}

async function loadOrCreateDeviceCredential(installationId: string): Promise<string | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      log.warn('safeStorage 不可用，当前设备不声明执行凭据')
      return null
    }

    const path = credentialPath()
    if (existsSync(path)) return readStoredCredential(path, installationId)

    const credential = randomBytes(32).toString('base64url')
    const encrypted = safeStorage.encryptString(credential).toString('base64')
    atomicWriteFileSync(path, JSON.stringify({
      installation_id: installationId,
      credential: `enc:${encrypted}`,
    } satisfies StoredDeviceCredential), { encoding: 'utf8', mode: 0o600 })
    return credential
  } catch {
    // Existing but unreadable/malformed credentials are never overwritten:
    // daemon-control still owns the original digest, so rotating locally would
    // permanently lock this installation out.
    log.warn('设备凭据读写失败，当前设备不声明执行凭据')
    return null
  }
}

/** 获取安装实例的设备凭据；无法加密落盘时返回 null，禁止明文降级。 */
export async function getOrCreateDeviceCredential(installationId: string): Promise<string | null> {
  const key = installationId.trim()
  if (!key) return null

  const current = inFlight.get(key)
  if (current) return current

  const pending = loadOrCreateDeviceCredential(key)
  inFlight.set(key, pending)
  try {
    return await pending
  } finally {
    inFlight.delete(key)
  }
}
