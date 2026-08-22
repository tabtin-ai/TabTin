/**
 * Electron 设备身份。
 *
 * `fingerprint` 是一次安装身份：首次生成 UUID 后绝不因版本升级或硬件探测而覆盖。
 * `machineKey` 是同机同运行档的恢复凭据：仅在重装后由服务端寻找同用户、唯一且离线的
 * 旧 Device 来保留其 Device.id / Space 绑定，不能取代安装身份。
 */
import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '@tabtin/terminal-core'
import { resolveRuntimeProfile, type TabTinRuntimeProfile } from '../app-identity'
import { createLogger } from '../logger'
import { getRawMachineId } from './machineId'

const log = createLogger('DeviceFingerprint')
const FILE_NAME = 'device-fingerprint.json'
const LEGACY_DEFAULT_USER_DATA_DIR_NAME = 'tabtin-electron'

export interface DeviceIdentity {
  /** 安装身份；只在当前 userData 尚无身份时生成。 */
  fingerprint: string
  /** 同机同 profile 的哈希恢复凭据；硬件不可读时为 null。 */
  machineKey: string | null
  /** 兼容旧注册协议的首个恢复候选。 */
  previousFingerprint: string | null
  /** 兼容旧协议的历史候选；新客户端不再从其它 profile 收集它。 */
  recoveryFingerprints: string[]
}

interface PersistedFingerprintFile {
  fingerprint?: string
  machine_key?: string
  previous_fingerprint?: string
  runtime_profile_revision?: number
}

let cached: DeviceIdentity | null = null

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function createRandomFingerprint(): string {
  return `electron-${randomUUID()}`
}

function deriveMachineKey(rawMachineId: string, profile: TabTinRuntimeProfile): string {
  return createHash('sha256')
    .update(`${rawMachineId}\0${profile}`, 'utf8')
    .digest('hex')
    .slice(0, 32)
}

function readFingerprintFile(fp: string): PersistedFingerprintFile | null {
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8')) as PersistedFingerprintFile
    if (typeof parsed.fingerprint === 'string' && parsed.fingerprint.length > 0) return parsed
  } catch {
    // 文件不存在或内容损坏
  }
  return null
}

function persist(fp: string, identity: DeviceIdentity): void {
  const body: PersistedFingerprintFile = { fingerprint: identity.fingerprint }
  if (identity.machineKey) body.machine_key = identity.machineKey
  if (identity.previousFingerprint) body.previous_fingerprint = identity.previousFingerprint
  const runtimeProfileRevision = readFingerprintFile(fp)?.runtime_profile_revision
  if (isRuntimeProfileRevision(runtimeProfileRevision)) {
    body.runtime_profile_revision = runtimeProfileRevision
  }
  try {
    atomicWriteFileSync(fp, JSON.stringify(body, null, 2), { mode: 0o600, mkdirSync: true })
  } catch (err) {
    log.warn('持久化设备指纹失败:', err)
  }
}

/**
 * 旧共享目录没有运行档语义，只允许正式版把它作为自己升级前的安装身份。
 * Dev / Preprod 绝不能从其它 profile 的文件收集候选，以免迁走正式现场。
 */
function legacyProductionFingerprint(
  currentPath: string,
  currentFingerprint: string,
  profile: TabTinRuntimeProfile,
): string | null {
  if (profile !== 'production') return null
  try {
    const candidatePath = join(app.getPath('appData'), LEGACY_DEFAULT_USER_DATA_DIR_NAME, FILE_NAME)
    if (candidatePath === currentPath) return null
    const fingerprint = readFingerprintFile(candidatePath)?.fingerprint?.trim()
    return fingerprint && fingerprint !== currentFingerprint ? fingerprint : null
  } catch {
    return null
  }
}

function resolveMachineKey(profile: TabTinRuntimeProfile): string | null {
  const raw = getRawMachineId()
  return raw ? deriveMachineKey(raw, profile) : null
}

/** 解析当前安装身份；更新只能补 machine_key，不能重写 fingerprint。 */
export function getDeviceIdentity(): DeviceIdentity {
  if (cached) return cached

  const profile = resolveRuntimeProfile()
  const fp = filePath()
  const existing = readFingerprintFile(fp)
  const fingerprint = existing?.fingerprint ?? createRandomFingerprint()
  const machineKey = resolveMachineKey(profile)
  const previousFingerprint = existing?.previous_fingerprint?.trim()
    || legacyProductionFingerprint(fp, fingerprint, profile)
    || null
  const identity: DeviceIdentity = {
    fingerprint,
    machineKey,
    previousFingerprint: previousFingerprint === fingerprint ? null : previousFingerprint,
    recoveryFingerprints: [],
  }

  if (!existing || existing.machine_key !== machineKey || (
    identity.previousFingerprint && existing.previous_fingerprint !== identity.previousFingerprint
  )) {
    persist(fp, identity)
  }

  cached = identity
  return cached
}

export function getDeviceFingerprint(): string {
  return getDeviceIdentity().fingerprint
}

function isRuntimeProfileRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** 以服务端与本地已确认 revision 的较大值生成下一次运行资料 revision。 */
export function nextDeviceRuntimeProfileRevision(serverRevision: unknown): number {
  const storedRevision = readFingerprintFile(filePath())?.runtime_profile_revision
  return Math.max(
    isRuntimeProfileRevision(storedRevision) ? storedRevision : 1,
    isRuntimeProfileRevision(serverRevision) ? serverRevision : 1,
  ) + 1
}

/** 仅在服务端确认同步后持久化，禁止本地 revision 倒退。 */
export function persistDeviceRuntimeProfileRevision(revision: number): void {
  if (!isRuntimeProfileRevision(revision)) return
  const fp = filePath()
  const stored = readFingerprintFile(fp)
  if (!stored || (
    isRuntimeProfileRevision(stored.runtime_profile_revision)
    && stored.runtime_profile_revision >= revision
  )) return
  try {
    atomicWriteFileSync(fp, JSON.stringify({
      ...stored,
      runtime_profile_revision: revision,
    }, null, 2), { mode: 0o600, mkdirSync: true })
  } catch (err) {
    log.warn('持久化设备运行资料 revision 失败:', err)
  }
}

/** 注册成功后清除已消费的当前运行档旧身份。 */
export function clearPreviousFingerprint(): void {
  const identity = getDeviceIdentity()
  if (!identity.previousFingerprint) return
  const next: DeviceIdentity = { ...identity, previousFingerprint: null }
  persist(filePath(), next)
  cached = next
}

export function _resetDeviceFingerprintCacheForTests(): void {
  cached = null
}
