import { existsSync, readFileSync, accessSync, constants } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import type { Cookie } from '../../types/cookies'
import type { ICookieExtractor, ExtractOptions, ExtractResult } from './types'
import { CREDENTIAL_ERROR_CODES } from './types'

const SAFARI_COOKIES_PATH = join(homedir(), 'Library', 'Cookies', 'Cookies.binarycookies')
const COCOA_EPOCH = 978307200

function checkFullDiskAccess(): boolean {
  try {
    accessSync(SAFARI_COOKIES_PATH, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function openFullDiskAccessSettings(): void {
  try {
    execSync(
      'open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"',
      { timeout: 3000 }
    )
  } catch {
    try {
      execSync('open /System/Library/PreferencePanes/Security.prefPane', { timeout: 3000 })
    } catch { /* ignore */ }
  }
}

function parseBinaryCookies(buf: Buffer, options?: ExtractOptions): Cookie[] {
  const cookies: Cookie[] = []
  const bufLen = buf.length

  if (bufLen < 8) {
    throw new Error('文件过小，不是有效的 binarycookies 文件')
  }

  const magic = buf.toString('ascii', 0, 4)
  if (magic !== 'cook') {
    throw new Error('不是有效的 binarycookies 文件')
  }

  const numPages = buf.readUInt32BE(4)
  const headerEnd = 8 + numPages * 4
  if (headerEnd > bufLen) {
    throw new Error(`文件头声明 ${numPages} 个页面但文件过小`)
  }

  const pageSizes: number[] = []
  for (let i = 0; i < numPages; i++) {
    pageSizes.push(buf.readUInt32BE(8 + i * 4))
  }

  let offset = headerEnd
  const nowSec = Math.floor(Date.now() / 1000)

  const domainFilters = options?.domains?.map(d => d.toLowerCase()) || []

  for (let p = 0; p < numPages; p++) {
    const pageStart = offset
    const pageSize = pageSizes[p]
    const pageEnd = pageStart + pageSize

    if (pageEnd > bufLen) break
    if (pageSize < 8) { offset = pageEnd; continue }

    const numCookiesInPage = buf.readUInt32LE(pageStart + 4)
    const cookieTableEnd = pageStart + 8 + numCookiesInPage * 4
    if (cookieTableEnd > pageEnd) { offset = pageEnd; continue }

    const cookieOffsets: number[] = []
    for (let c = 0; c < numCookiesInPage; c++) {
      cookieOffsets.push(buf.readUInt32LE(pageStart + 8 + c * 4))
    }

    for (const cookieOffset of cookieOffsets) {
      try {
        const cStart = pageStart + cookieOffset
        if (cStart < pageStart || cStart + 56 > pageEnd) continue

        const cookieSize = buf.readUInt32LE(cStart)
        if (cookieSize < 56 || cStart + cookieSize > pageEnd) continue

        const flags = buf.readUInt32LE(cStart + 8)

        const urlOffset = buf.readUInt32LE(cStart + 16)
        const nameOffset = buf.readUInt32LE(cStart + 20)
        const pathOffset = buf.readUInt32LE(cStart + 24)
        const valueOffset = buf.readUInt32LE(cStart + 28)

        const maxFieldOffset = cookieSize
        if (urlOffset >= maxFieldOffset || nameOffset >= maxFieldOffset ||
            pathOffset >= maxFieldOffset || valueOffset >= maxFieldOffset) {
          continue
        }

        const expiryDate = buf.readDoubleLE(cStart + 40) + COCOA_EPOCH

        const readCString = (off: number): string => {
          const start = cStart + off
          if (start >= pageEnd) return ''
          let end = start
          const limit = Math.min(pageEnd, cStart + cookieSize)
          while (end < limit && buf[end] !== 0) end++
          return buf.toString('utf-8', start, end)
        }

        const domain = readCString(urlOffset)
        const name = readCString(nameOffset)
        const path = readCString(pathOffset)
        const value = readCString(valueOffset)

        if (!options?.includeExpired && expiryDate > 0 && expiryDate < nowSec) {
          continue
        }

        if (domainFilters.length > 0) {
          const lowerDomain = domain.toLowerCase()
          if (!domainFilters.some(f => lowerDomain.includes(f))) {
            continue
          }
        }

        const isSecure = (flags & 0x1) !== 0
        const isHttpOnly = (flags & 0x4) !== 0

        cookies.push({
          name,
          value,
          domain,
          path: path || '/',
          expires: Math.floor(expiryDate),
          size: (name + value).length,
          httpOnly: isHttpOnly,
          secure: isSecure,
          session: expiryDate <= 0,
          sameSite: 'Lax',
        })
      } catch {
        // skip malformed cookies
      }
    }

    offset = pageEnd
  }

  return cookies
}

export class SafariExtractor implements ICookieExtractor {
  async extract(_profilePath: string, options?: ExtractOptions): Promise<ExtractResult> {
    if (process.platform !== 'darwin') {
      return {
        success: false,
        cookies: [],
        browserName: 'safari',
        profileName: 'Default',
        extractedAt: new Date().toISOString(),
        error: 'Safari 仅在 macOS 上可用',
        errorCode: CREDENTIAL_ERROR_CODES.UNSUPPORTED_BROWSER,
      }
    }

    if (!existsSync(SAFARI_COOKIES_PATH)) {
      return {
        success: false,
        cookies: [],
        browserName: 'safari',
        profileName: 'Default',
        extractedAt: new Date().toISOString(),
        error: 'Safari Cookie 文件不存在',
        errorCode: CREDENTIAL_ERROR_CODES.COOKIE_DB_MISSING,
      }
    }

    if (!checkFullDiskAccess()) {
      openFullDiskAccessSettings()
      return {
        success: false,
        cookies: [],
        browserName: 'safari',
        profileName: 'Default',
        extractedAt: new Date().toISOString(),
        error: '需要完全磁盘访问权限。已打开系统偏好设置，请将 TabTin 添加到完全磁盘访问列表后重试。',
      }
    }

    try {
      const buf = readFileSync(SAFARI_COOKIES_PATH)
      const cookies = parseBinaryCookies(buf, options)

      return {
        success: true,
        cookies,
        browserName: 'safari',
        profileName: 'Default',
        extractedAt: new Date().toISOString(),
      }
    } catch (error: any) {
      return {
        success: false,
        cookies: [],
        browserName: 'safari',
        profileName: 'Default',
        extractedAt: new Date().toISOString(),
        error: error.message || String(error),
      }
    }
  }
}
