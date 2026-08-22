import { join, basename } from 'path'
import { existsSync, copyFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import type { Cookie } from '../../types/cookies'
import type { ICookieExtractor, ExtractOptions, ExtractResult } from './types'
import { CREDENTIAL_ERROR_CODES } from './types'
import { withSqliteFile } from '../../utils/sql-js-helper'

function sameSiteFromInt(value: number): 'Strict' | 'Lax' | 'None' {
  switch (value) {
    case 0: return 'None'
    case 1: return 'Lax'
    case 2: return 'Strict'
    default: return 'Lax'
  }
}

export class FirefoxExtractor implements ICookieExtractor {
  async extract(profilePath: string, options?: ExtractOptions): Promise<ExtractResult> {
    const cookieDbPath = join(profilePath, 'cookies.sqlite')
    if (!existsSync(cookieDbPath)) {
      return {
        success: false,
        cookies: [],
        browserName: 'firefox',
        profileName: basename(profilePath) || 'Unknown',
        extractedAt: new Date().toISOString(),
        error: `Cookie 数据库不存在: ${cookieDbPath}`,
        errorCode: CREDENTIAL_ERROR_CODES.COOKIE_DB_MISSING,
      }
    }

    const tempDb = join(tmpdir(), `tabtin-firefox-cookies-${Date.now()}.db`)

    try {
      copyFileSync(cookieDbPath, tempDb)

      const cookies = await withSqliteFile(tempDb, (db) => {
        let query = `
          SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
          FROM moz_cookies
        `
        const params: unknown[] = []

        if (options?.domains && options.domains.length > 0) {
          const placeholders = options.domains.map(() => 'host LIKE ?')
          query += ` WHERE (${placeholders.join(' OR ')})`
          for (const domain of options.domains) {
            params.push(`%${domain}`)
          }
        }

        if (!options?.includeExpired) {
          const nowSec = Math.floor(Date.now() / 1000)
          query += params.length > 0 ? ' AND' : ' WHERE'
          query += ` (expiry = 0 OR expiry > ${nowSec})`
        }

        const rows = db.queryAll(query, params.length > 0 ? params : undefined)
        const result: Cookie[] = []

        for (const row of rows) {
          result.push({
            name: row.name as string,
            value: (row.value as string) || '',
            domain: row.host as string,
            path: (row.path as string) || '/',
            expires: (row.expiry as number) || -1,
            size: ((row.name as string) + ((row.value as string) || '')).length,
            httpOnly: Boolean(row.isHttpOnly),
            secure: Boolean(row.isSecure),
            session: !row.expiry || row.expiry === 0,
            sameSite: sameSiteFromInt(row.sameSite as number),
          })
        }

        return result
      })

      return {
        success: true,
        cookies,
        browserName: 'firefox',
        profileName: basename(profilePath) || 'Unknown',
        extractedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      return {
        success: false,
        cookies: [],
        browserName: 'firefox',
        profileName: basename(profilePath) || 'Unknown',
        extractedAt: new Date().toISOString(),
        error: error.message || String(error),
      }
    } finally {
      try { unlinkSync(tempDb) } catch { /* ignore */ }
    }
  }
}
