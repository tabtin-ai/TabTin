/**
 * safe-credential-store.ts — 替代 keytar 的轻量凭证存储
 *
 * 历史背景：
 *   keytar 7.9.0 (2022) 在 macOS 26 Tahoe 上调用 Security framework 时
 *   会抛 C++ 异常，跨 N-API 边界后触发 std::terminate → abort，
 *   连 main 进程都直接拉崩，且 Promise `.catch()` 拦不住。线上多次复现。
 *
 * 设计：
 *   - 用 Electron 自带的 `safeStorage`（OS 提供的加密层，macOS 用 Keychain
 *     底层 API，Linux 用 secret-service / kwallet，Windows 用 DPAPI）
 *   - 凭证内容加密后落到 `userData/credentials.json`，避免每次原子写入
 *     时跟 OS 弹授权对话框
 *   - 暴露与 `keytar` 同形态的 `getPassword / setPassword / deletePassword`
 *     接口，便于 auth.ts 等调用方零改造迁移
 *
 * 限制：
 *   - 当 `safeStorage.isEncryptionAvailable()` 返回 false（Linux 上无密钥环、
 *     macOS 用户拒绝了 Keychain 等极端情况）时回退到 base64 明文，会打 warn
 *     日志。这种降级在用户视角等同"换台机器要重登录"，对预发阶段可接受。
 *     安全影响：base64 仅是编码不是加密，`userData/credentials.json` 落盘后
 *     任何能读到该文件的本机进程均可 base64 解码还原登录凭证明文，存在磁盘
 *     可读风险；生产环境应保证系统密钥环可用。
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '@tabtin/terminal-core'
import { createLogger } from './logger'

const log = createLogger('SafeCredentialStore')

type StoreShape = Record<string, Record<string, string>>

const FILE_NAME = 'credentials.json'

let cached: StoreShape | null = null
let warnedNoEncryption = false
let storeUnreadable = false

function getStorePath(): string {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, FILE_NAME)
}

function encryptToString(plain: string, requireEncryption = false): string {
  if (safeStorage.isEncryptionAvailable()) {
    return `enc:${safeStorage.encryptString(plain).toString('base64')}`
  }
  if (requireEncryption) {
    throw new Error('safeStorage encryption unavailable')
  }
  if (!warnedNoEncryption) {
    log.warn(
      'safeStorage 不可用，凭证以 base64 明文降级存储，存在磁盘可读风险' +
        '（任何能读 userData/credentials.json 的本机进程均可 base64 解码还原明文）',
    )
    warnedNoEncryption = true
  }
  return `b64:${Buffer.from(plain, 'utf8').toString('base64')}`
}

function decryptFromString(stored: string, requireReadable = false): string | null {
  try {
    if (stored.startsWith('enc:')) {
      const buf = Buffer.from(stored.slice(4), 'base64')
      return safeStorage.decryptString(buf)
    }
    if (stored.startsWith('b64:')) {
      return Buffer.from(stored.slice(4), 'base64').toString('utf8')
    }
    if (requireReadable) throw new Error('unsupported credential encoding')
    return null
  } catch (error) {
    log.warn('解密凭证失败（可能是换了机器或 Keychain 重置）：', error)
    if (requireReadable) throw error
    return null
  }
}

function loadStore(): StoreShape {
  if (cached) return cached
  const path = getStorePath()
  if (!existsSync(path)) {
    cached = {}
    return cached
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    cached = parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    log.warn('凭证文件损坏，已重置：', error)
    storeUnreadable = true
    cached = {}
  }
  return cached as StoreShape
}

function persistStore(): void {
  if (!cached) return
  const path = getStorePath()
  atomicWriteFileSync(path, JSON.stringify(cached, null, 0), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/**
 * 与 keytar 兼容的接口。所有方法均同步实现，但保留 Promise 签名方便平滑迁移。
 */
export const credentialStore = {
  async getPassword(
    service: string,
    account: string,
    options?: { requireReadable?: boolean },
  ): Promise<string | null> {
    try {
      const store = loadStore()
      if (options?.requireReadable && storeUnreadable) {
        throw new Error('credential store is unreadable')
      }
      const stored = store[service]?.[account]
      if (!stored) return null
      return decryptFromString(stored, options?.requireReadable)
    } catch (error) {
      log.warn('getPassword 失败：', error)
      if (options?.requireReadable) throw error
      return null
    }
  },

  async setPassword(
    service: string,
    account: string,
    value: string,
    options?: { requireEncryption?: boolean },
  ): Promise<void> {
    const store = loadStore()
    if (options?.requireEncryption && storeUnreadable) {
      throw new Error('credential store is unreadable')
    }
    if (!store[service]) store[service] = {}
    store[service][account] = encryptToString(value, options?.requireEncryption)
    persistStore()
    // 写凭证：只记 service 名 + 值长度（诊断"写没写进去"），绝不记 account 明文 / value
    log.debug('setPassword', { service, valueLen: value.length })
  },

  async deletePassword(service: string, account: string): Promise<boolean> {
    const store = loadStore()
    if (!store[service] || !(account in store[service])) {
      return false
    }
    delete store[service][account]
    if (Object.keys(store[service]).length === 0) {
      delete store[service]
    }
    persistStore()
    // 删除凭证（不可逆）：只记 service 名，不记 account 明文
    log.info('deletePassword 完成', { service })
    return true
  },

  /** 清空所有凭证（仅退出登录场景下使用） */
  async clearAll(): Promise<void> {
    cached = {}
    storeUnreadable = false
    const path = getStorePath()
    // 清空全部凭证（等同强制登出，不可逆）——退出登录排查关键信号
    log.info('clearAll 清空全部凭证')
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch (error) {
      log.warn('清理凭证文件失败：', error)
    }
  },
}

export type CredentialStore = typeof credentialStore
