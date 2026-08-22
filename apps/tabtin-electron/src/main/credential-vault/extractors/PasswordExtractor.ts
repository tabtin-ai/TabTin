import { join, basename, dirname } from 'path'
import { existsSync, copyFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { getDecryptionKey, decryptValue } from './crypto-utils'
import type { IPasswordExtractor, PasswordExtractResult, ExtractedPassword } from './types'
import { CREDENTIAL_ERROR_CODES } from './types'
import { withSqliteFile } from '../../utils/sql-js-helper'

/**
 * 从 Chromium 系浏览器（Chrome / Edge / Brave 等）提取已存储的网站密码。
 * macOS: AES-128-CBC + Keychain；Windows: AES-256-GCM + DPAPI。
 */
export class PasswordExtractor implements IPasswordExtractor {
  private browserName: string

  constructor(browserName: string = 'chrome') {
    this.browserName = browserName
  }

  async extractPasswords(profilePath: string): Promise<PasswordExtractResult> {
    const loginDbPath = join(profilePath, 'Login Data')
    const profileName = basename(profilePath) || 'Unknown'

    if (!existsSync(loginDbPath)) {
      return {
        success: false,
        passwords: [],
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
        error: `Login Data 数据库不存在: ${loginDbPath}`,
        errorCode: CREDENTIAL_ERROR_CODES.COOKIE_DB_MISSING,
      }
    }

    const userDataDir = dirname(profilePath)
    const key = getDecryptionKey(this.browserName, userDataDir)
    if (!key) {
      return {
        success: false,
        passwords: [],
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
        error: `无法获取 ${this.browserName} 解密密钥`,
        errorCode: CREDENTIAL_ERROR_CODES.DECRYPT_KEY_UNAVAILABLE,
      }
    }

    const tempDb = join(tmpdir(), `tabtin-login-data-${Date.now()}.db`)

    try {
      copyFileSync(loginDbPath, tempDb)

      const passwords = await withSqliteFile(tempDb, (db) => {
        const rows = db.queryAll(`
          SELECT origin_url, username_value, password_value, signon_realm, date_created
          FROM logins
          WHERE blacklisted_by_user = 0
            AND username_value != ''
            AND LENGTH(password_value) > 0
        `)

        const result: ExtractedPassword[] = []

        for (const row of rows) {
          const encrypted = row.password_value
          const encBuf = encrypted instanceof Uint8Array
            ? Buffer.from(encrypted)
            : null
          if (!encBuf || encBuf.length === 0) continue

          const password = decryptValue(encBuf, key)
          if (!password) continue

          const chromeEpoch = 11644473600
          const dateCreated = row.date_created
            ? Math.floor(Number(row.date_created) / 1000000) - chromeEpoch
            : undefined

          result.push({
            url: row.origin_url as string,
            username: row.username_value as string,
            password,
            signon_realm: row.signon_realm as string,
            date_created: dateCreated,
          })
        }

        return result
      })

      return {
        success: true,
        passwords,
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      return {
        success: false,
        passwords: [],
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
        error: error.message || String(error),
      }
    } finally {
      try { unlinkSync(tempDb) } catch { /* ignore */ }
    }
  }
}
