import { join, basename, dirname } from 'path'
import { existsSync, copyFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import type { Cookie } from '../../types/cookies'
import type { ICookieExtractor, ExtractOptions, ExtractResult } from './types'
import { CREDENTIAL_ERROR_CODES } from './types'
import { getDecryptionKey, decryptValue } from './crypto-utils'
import { withSqliteFile } from '../../utils/sql-js-helper'

function sameSiteFromInt(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None'
    case 1: return 'Lax'
    case 2: return 'Strict'
    default: return 'Lax'
  }
}

export class ChromeExtractor implements ICookieExtractor {
  private browserName: string

  constructor(browserName: string = 'chrome') {
    this.browserName = browserName
  }

  async extract(profilePath: string, options?: ExtractOptions): Promise<ExtractResult> {
    const cookieDbPath = join(profilePath, 'Cookies')
    const profileName = basename(profilePath) || 'Unknown'

    if (!existsSync(cookieDbPath)) {
      return {
        success: false,
        cookies: [],
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
        error: `Cookie 数据库不存在: ${cookieDbPath}`,
        errorCode: CREDENTIAL_ERROR_CODES.COOKIE_DB_MISSING,
      }
    }

    const userDataDir = dirname(profilePath)
    const key = getDecryptionKey(this.browserName, userDataDir)
    if (!key) {
      return {
        success: false,
        cookies: [],
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
        error: `无法获取 ${this.browserName} 解密密钥`,
        errorCode: CREDENTIAL_ERROR_CODES.DECRYPT_KEY_UNAVAILABLE,
      }
    }

    const tempDb = join(tmpdir(), `tabtin-chrome-cookies-${Date.now()}.db`)

    try {
      copyFileSync(cookieDbPath, tempDb)

      const cookies = await withSqliteFile(tempDb, (db) => {
        let query = `
          SELECT host_key, name, encrypted_value, path, expires_utc,
                 is_secure, is_httponly, samesite, has_expires
          FROM cookies
        `
        const params: unknown[] = []

        if (options?.domains && options.domains.length > 0) {
          const placeholders = options.domains.map(() => 'host_key LIKE ?')
          query += ` WHERE (${placeholders.join(' OR ')})`
          for (const domain of options.domains) {
            params.push(`%${domain}`)
          }
        }

        if (!options?.includeExpired) {
          const chromeEpoch = 11644473600n
          const nowMicro = (BigInt(Math.floor(Date.now() / 1000)) + chromeEpoch) * 1000000n
          query += params.length > 0 ? ' AND' : ' WHERE'
          query += ` (has_expires = 0 OR expires_utc > ${nowMicro.toString()})`
        }

        const rows = db.queryAll(query, params.length > 0 ? params : undefined)
        const result: Cookie[] = []

        for (const row of rows) {
          const encrypted = row.encrypted_value
          const encBuf = encrypted instanceof Uint8Array
            ? Buffer.from(encrypted)
            : null
          const value = encBuf && encBuf.length > 0
            ? decryptValue(encBuf, key)
            : ''

          if (!value && encBuf && encBuf.length > 0) continue

          const chromeEpoch = 11644473600
          const expiresUtc = Number(row.expires_utc)
          const expires = row.has_expires && expiresUtc > 0
            ? Math.floor(expiresUtc / 1000000) - chromeEpoch
            : -1

          result.push({
            name: row.name as string,
            value,
            domain: row.host_key as string,
            path: (row.path as string) || '/',
            expires,
            size: ((row.name as string) + value).length,
            httpOnly: Boolean(row.is_httponly),
            secure: Boolean(row.is_secure),
            session: !row.has_expires,
            sameSite: sameSiteFromInt(row.samesite as number),
          })
        }

        return result
      })

      return {
        success: true,
        cookies,
        browserName: this.browserName,
        profileName,
        extractedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      return {
        success: false,
        cookies: [],
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
