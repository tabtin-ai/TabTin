import { execSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import crypto from 'crypto'
import { createLogger } from '../../logger'

const log = createLogger('CryptoUtils')

export const KEYCHAIN_SERVICE_MAP: Record<string, string> = {
  chrome: 'Chrome Safe Storage',
  edge: 'Microsoft Edge Safe Storage',
  chromium: 'Chromium Safe Storage',
  brave: 'Brave Safe Storage',
  vivaldi: 'Vivaldi Safe Storage',
  opera: 'Opera Safe Storage',
}

const PBKDF2_ITERATIONS = 1003
const PBKDF2_KEY_LENGTH = 16
const AES_IV = Buffer.alloc(16, ' ')

function getDecryptionKeyMacOS(browserName: string): Buffer | null {
  const serviceName = KEYCHAIN_SERVICE_MAP[browserName]
  if (!serviceName) {
    log.warn('未知浏览器，无对应 Keychain service', { browser: browserName })
    return null
  }

  try {
    const password = execSync(
      `security find-generic-password -s "${serviceName}" -w`,
      { encoding: 'utf-8', timeout: 5000 }
    ).trim()

    return crypto.pbkdf2Sync(password, 'saltysalt', PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
  } catch (error: any) {
    // 命令行不含密钥（只有 service 名），错误信息可安全记录
    log.error('无法获取 Keychain 解密密钥', { service: serviceName, error: error?.message })
    return null
  }
}

function dpapiDecrypt(encryptedBytes: Buffer): Buffer {
  const b64Input = encryptedBytes.toString('base64')

  const psScript = [
    'Add-Type -AssemblyName System.Security;',
    `$enc=[Convert]::FromBase64String('${b64Input}');`,
    '$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($enc,$null,\'CurrentUser\');',
    '[Convert]::ToBase64String($dec)',
  ].join(' ')

  const result = execSync(
    `powershell -NoProfile -NonInteractive -Command "${psScript}"`,
    { encoding: 'utf-8', timeout: 10000, windowsHide: true }
  ).trim()

  return Buffer.from(result, 'base64')
}

function getDecryptionKeyWindows(userDataDir: string): Buffer | null {
  const localStatePath = join(userDataDir, 'Local State')
  if (!existsSync(localStatePath)) {
    log.error('Local State 不存在')
    return null
  }

  try {
    const localState = JSON.parse(readFileSync(localStatePath, 'utf-8'))
    const encryptedKeyB64: string | undefined = localState?.os_crypt?.encrypted_key
    if (!encryptedKeyB64) {
      log.error('Local State 中未找到 os_crypt.encrypted_key')
      return null
    }

    const encryptedKeyRaw = Buffer.from(encryptedKeyB64, 'base64')

    const DPAPI_PREFIX = 'DPAPI'
    if (encryptedKeyRaw.subarray(0, 5).toString('utf-8') !== DPAPI_PREFIX) {
      log.error('encrypted_key 缺少 DPAPI 前缀')
      return null
    }

    const dpapiBlob = encryptedKeyRaw.subarray(5)
    return dpapiDecrypt(dpapiBlob)
  } catch (error: any) {
    // 注意：dpapiDecrypt 的错误 message 会内嵌 PowerShell 命令（含加密密钥 blob），
    // 因此只记录错误类型/退出码，绝不记录 error.message / 完整错误对象。
    log.error('Windows 解密密钥获取失败', { name: error?.name, code: error?.code })
    return null
  }
}

/**
 * 获取 Chromium 系浏览器的解密密钥。
 * @param browserName - 浏览器标识（chrome / edge / brave ...）
 * @param userDataDir - Windows 上必须提供的 User Data 目录（Local State 所在目录）；macOS 忽略
 */
export function getDecryptionKey(browserName: string, userDataDir?: string): Buffer | null {
  if (process.platform === 'darwin') {
    return getDecryptionKeyMacOS(browserName)
  }

  if (process.platform === 'win32') {
    if (!userDataDir) {
      log.error('Windows 平台需要提供 userDataDir 参数')
      return null
    }
    return getDecryptionKeyWindows(userDataDir)
  }

  log.warn('不支持的平台', { platform: process.platform })
  return null
}

function decryptAesCbc(ciphertext: Buffer, key: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, AES_IV)
  decipher.setAutoPadding(true)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

function decryptAesGcm(payload: Buffer, key: Buffer): string {
  const nonce = payload.subarray(0, 12)
  const tag = payload.subarray(payload.length - 16)
  const ciphertext = payload.subarray(12, payload.length - 16)

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8')
}

/**
 * 解密 Chromium 存储的加密值（Cookie value / Password value）。
 * 通过密钥长度自动选择算法：16字节 → AES-128-CBC (macOS)，32字节 → AES-256-GCM (Windows)。
 */
export function decryptValue(encrypted: Buffer, key: Buffer): string {
  if (encrypted.length <= 3) return ''

  const version = encrypted.subarray(0, 3).toString('utf-8')

  if (version === 'v10' || version === 'v11') {
    try {
      const body = encrypted.subarray(3)
      if (key.length === 32) {
        return decryptAesGcm(body, key)
      }
      return decryptAesCbc(body, key)
    } catch (error: any) {
      // 逐值解密失败（错误密钥 / 数据损坏）：吞掉返回空串以免中断整批提取。
      // 高频路径，仅记 debug（dev-only），绝不记录密文/明文，只记算法与错误类型。
      log.debug('decryptValue v10/v11 解密失败', { keyLen: key.length, name: error?.name })
      return ''
    }
  }

  if (process.platform === 'win32') {
    try {
      return dpapiDecrypt(encrypted).toString('utf-8')
    } catch (error: any) {
      // 同上：单值 DPAPI 解密失败吞掉，避免中断整批；不记录内容。
      log.debug('decryptValue DPAPI 解密失败', { name: error?.name, code: error?.code })
      return ''
    }
  }

  return encrypted.toString('utf-8')
}
