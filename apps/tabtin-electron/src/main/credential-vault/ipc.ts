import { ipcMain, session, dialog } from 'electron'
import { resolve, sep } from 'path'
import { homedir } from 'os'
import { guardedHandle } from '../utils/guarded-handle'
import { readFile, writeFile, stat } from 'fs/promises'
import { detectInstalledBrowsers } from './browser-detector'
import { ChromeExtractor } from './extractors/ChromeExtractor'
import { FirefoxExtractor } from './extractors/FirefoxExtractor'
import { SafariExtractor } from './extractors/SafariExtractor'
import { PasswordExtractor } from './extractors/PasswordExtractor'
import { registerAutofillHandlers, initAutofillService } from './autofill-service'
import type { ICookieExtractor, IPasswordExtractor, ExtractOptions, PartitionCookieSummary, CookieDomainSummary } from './extractors/types'
import type { Cookie } from '../types/cookies'
import { createLogger } from '../logger'

const log = createLogger('CredentialVault')

const extractors: Record<string, ICookieExtractor> = {
  chrome: new ChromeExtractor('chrome'),
  edge: new ChromeExtractor('edge'),
  firefox: new FirefoxExtractor(),
  safari: new SafariExtractor(),
}

const passwordExtractors: Record<string, IPasswordExtractor> = {
  chrome: new PasswordExtractor('chrome'),
  edge: new PasswordExtractor('edge'),
}

function getKnownBrowserProfileDirs(): string[] {
  const home = homedir()
  const dirs: string[] = []
  if (process.platform === 'darwin') {
    dirs.push(
      resolve(home, 'Library', 'Application Support', 'Google', 'Chrome'),
      resolve(home, 'Library', 'Application Support', 'Google', 'Chrome Canary'),
      resolve(home, 'Library', 'Application Support', 'Microsoft Edge'),
      resolve(home, 'Library', 'Application Support', 'Firefox', 'Profiles'),
      resolve(home, 'Library', 'Cookies'),
    )
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || resolve(home, 'AppData', 'Local')
    dirs.push(
      resolve(localAppData, 'Google', 'Chrome', 'User Data'),
      resolve(localAppData, 'Microsoft', 'Edge', 'User Data'),
      resolve(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'),
    )
  } else {
    dirs.push(
      resolve(home, '.config', 'google-chrome'),
      resolve(home, '.config', 'chromium'),
      resolve(home, '.config', 'microsoft-edge'),
      resolve(home, '.mozilla', 'firefox'),
    )
  }
  return dirs
}

function isAllowedProfilePath(profilePath: string): boolean {
  if (!profilePath || typeof profilePath !== 'string') return false
  const normalized = resolve(profilePath)
  const allowedDirs = getKnownBrowserProfileDirs()
  return allowedDirs.some(dir => normalized === dir || normalized.startsWith(dir + sep))
}

// 白名单允许的 partition 前缀：
//   - `tabtin:organization:` —— 边界改造 Phase 3a 引入的 Organization 级浏览器 partition
//     （`tabtin:organization:{id}:browser`），普通浏览器（桌面 + 对话）的共享 cookie
//     罐。凭据导入 / 同步 / 自动填充都注入到这个罐，必须放行；否则 inject /
//     getPartitionCookies 会被白名单静默拒绝，导入的登录态进不去浏览罐。
//   - `tabtin:env:` —— 主进程 BrowserEnvironmentService 专管的登录环境 partition
//     （`tabtin:env:default` / `tabtin:env:{uuid}`），credential-vault 的 inject /
//     clear / check-login-status 等 IPC 都在这个族上工作。显式 env 绑定（legacy，
//     UI 已移除但数据模型保留）的 Space 仍映射到这个前缀。
//   - `task-` —— `SessionConfigFactory.custom` 在 `sessionMode='isolated'` 路径
//     创建的 task 临时 partition。
//
// **承重墙**：隔离 named session 的 `tabtin:session:*` **不在白名单**——它是独立
// 浏览器身份，凭据库不应跨它读写（与 isAllowedPartition.test.ts 的反向断言对齐）。
//
// 历史 `tabtin:crawlspace:` 前缀已于 2026-05-01 完全本地化退役（详见
// 不再监听该前缀，全仓库无生产代码会向 credential-vault 传该前缀，留在白名单
// 即纯死代码 + 攻击面（任意 caller 传该前缀即可调 credential 操作）。
const ALLOWED_PARTITION_PREFIXES = ['tabtin:organization:', 'tabtin:env:', 'task-']

export function isAllowedPartition(partition: string): boolean {
  if (!partition || typeof partition !== 'string') return false
  const stripped = partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition
  return ALLOWED_PARTITION_PREFIXES.some(prefix => stripped.startsWith(prefix))
}

const MAX_COOKIE_IMPORT_SIZE = 10 * 1024 * 1024 // 10MB

function isValidCookieEntry(c: unknown): c is Cookie {
  if (!c || typeof c !== 'object') return false
  const obj = c as Record<string, unknown>
  return (
    typeof obj.name === 'string' && obj.name.length > 0 && obj.name.length <= 4096 &&
    typeof obj.value === 'string' && obj.value.length <= 8192 &&
    typeof obj.domain === 'string' && obj.domain.length > 0 && obj.domain.length <= 253
  )
}

export function registerCredentialVaultHandlers(): void {
  guardedHandle(
    'credential-vault:detect-browsers',
    async () => {
      try {
        const browsers = detectInstalledBrowsers()
        log.info('detect-browsers 完成', { count: browsers.length })
        return { success: true, browsers }
      } catch (error: any) {
        log.error('detect-browsers 失败:', error?.message)
        return { success: false, browsers: [], error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:extract-cookies',
    async (
      _,
      payload: {
        browser: string
        profilePath: string
        options?: ExtractOptions
      }
    ) => {
      try {
        const extractor = extractors[payload.browser]
        if (!extractor) {
          log.warn('extract-cookies 不支持的浏览器', { browser: payload.browser })
          return { success: false, error: `不支持的浏览器: ${payload.browser}` }
        }
        if (!isAllowedProfilePath(payload.profilePath)) {
          log.warn('extract-cookies profile 路径被拒绝', { browser: payload.browser })
          return { success: false, cookies: [], error: '不允许的 profile 路径：必须位于已知浏览器 profile 目录中' }
        }
        log.info('extract-cookies 开始', { browser: payload.browser })
        const result = await extractor.extract(payload.profilePath, payload.options)
        const ok = (result as { success?: boolean })?.success !== false
        log.info('extract-cookies 完成', {
          browser: payload.browser,
          success: ok,
          count: (result as { cookies?: unknown[] })?.cookies?.length ?? 0,
          ...(ok ? {} : { error: (result as { error?: string })?.error }),
        })
        return result
      } catch (error: any) {
        log.error('extract-cookies 失败', { browser: payload.browser, error: error?.message })
        return { success: false, cookies: [], error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:inject-cookies',
    async (
      _,
      payload: {
        partition: string
        cookies: Cookie[]
      }
    ) => {
      try {
        if (!isAllowedPartition(payload.partition)) {
          log.warn('inject-cookies partition 被拒绝', { partition: payload.partition })
          return { success: false, error: '不允许的 partition：不在白名单范围内' }
        }
        log.info('inject-cookies 开始', {
          partition: payload.partition,
          count: payload.cookies?.length ?? 0,
        })
        const partitionKey = payload.partition.startsWith('persist:')
          ? payload.partition
          : `persist:${payload.partition}`
        const ses = session.fromPartition(partitionKey)
        let injected = 0
        let failed = 0

        const BATCH_SIZE = 50
        for (let i = 0; i < payload.cookies.length; i += BATCH_SIZE) {
          const batch = payload.cookies.slice(i, i + BATCH_SIZE)
          const results = await Promise.allSettled(
            batch.map(cookie => {
              const domain = cookie.domain || ''
              const cleanDomain = domain.startsWith('.') ? domain.substring(1) : domain
              const protocol = cookie.secure ? 'https' : 'http'
              const url = `${protocol}://${cleanDomain}${cookie.path || '/'}`

              let sameSite: 'no_restriction' | 'lax' | 'strict' = 'lax'
              const raw = (cookie.sameSite || '').toLowerCase()
              if (raw === 'none' || raw === 'no_restriction') {
                sameSite = 'no_restriction'
              } else if (raw === 'strict') {
                sameSite = 'strict'
              }

              const secure = sameSite === 'no_restriction' ? true : (cookie.secure ?? false)

              return ses.cookies.set({
                url: sameSite === 'no_restriction' ? `https://${cleanDomain}${cookie.path || '/'}` : url,
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: cookie.path,
                secure,
                httpOnly: cookie.httpOnly,
                expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
                sameSite,
              })
            })
          )
          for (const r of results) {
            if (r.status === 'fulfilled') injected++
            else failed++
          }
        }

        log.info('inject-cookies 完成', { partition: payload.partition, injected, failed })
        return { success: true, injected, failed }
      } catch (error: any) {
        log.error('inject-cookies 失败', { partition: payload.partition, error: error?.message })
        return { success: false, injected: 0, failed: 0, error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:get-partition-cookies',
    async (_, payload: { partition: string }) => {
      try {
        if (!isAllowedPartition(payload.partition)) {
          return { success: false, error: '不允许的 partition：不在白名单范围内' }
        }
        const partitionKey = payload.partition.startsWith('persist:')
          ? payload.partition
          : `persist:${payload.partition}`
        const ses = session.fromPartition(partitionKey)
        const allCookies = await ses.cookies.get({})

        const domainMap = new Map<string, { total: number; expired: number }>()
        const now = Math.floor(Date.now() / 1000)

        for (const cookie of allCookies) {
          const domain = cookie.domain || 'unknown'
          const entry = domainMap.get(domain) || { total: 0, expired: 0 }
          entry.total++
          if (cookie.expirationDate && cookie.expirationDate < now) {
            entry.expired++
          }
          domainMap.set(domain, entry)
        }

        const domains: CookieDomainSummary[] = []
        for (const [domain, stats] of domainMap) {
          domains.push({
            domain,
            count: stats.total,
            hasExpired: stats.expired > 0,
            expiredCount: stats.expired,
          })
        }

        domains.sort((a, b) => b.count - a.count)

        const summary: PartitionCookieSummary = {
          partition: payload.partition,
          totalCount: allCookies.length,
          domains,
        }

        return { success: true, summary }
      } catch (error: any) {
        log.error('get-partition-cookies 失败', { partition: payload.partition, error: error?.message })
        return { success: false, error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:clear-partition-cookies',
    async (_, payload: { partition: string; domain?: string }) => {
      try {
        if (!isAllowedPartition(payload.partition)) {
          log.warn('clear-partition-cookies partition 被拒绝', { partition: payload.partition })
          return { success: false, error: '不允许的 partition：不在白名单范围内' }
        }
        const partitionKey = payload.partition.startsWith('persist:')
          ? payload.partition
          : `persist:${payload.partition}`
        const ses = session.fromPartition(partitionKey)

        const filter = payload.domain ? { domain: payload.domain } : {}
        const cookies = await ses.cookies.get(filter)
        // 不可逆删除操作：记录范围与命中数（domain 是可诊断标识，非敏感值）
        log.info('clear-partition-cookies 开始', {
          partition: payload.partition,
          domain: payload.domain ?? '(all)',
          matched: cookies.length,
        })

        let removed = 0
        let removeFailed = 0
        for (const cookie of cookies) {
          try {
            const domain = cookie.domain || ''
            const cleanDomain = domain.startsWith('.') ? domain.substring(1) : domain
            const protocol = cookie.secure ? 'https' : 'http'
            const url = `${protocol}://${cleanDomain}${cookie.path || '/'}`
            await ses.cookies.remove(url, cookie.name)
            removed++
          } catch {
            // 单条删除失败不阻断整体清理；计数后在结束时汇总一条 warn
            removeFailed++
          }
        }

        if (removeFailed > 0) {
          log.warn('clear-partition-cookies 部分 cookie 删除失败', {
            partition: payload.partition,
            removed,
            removeFailed,
          })
        }
        log.info('clear-partition-cookies 完成', { partition: payload.partition, removed })
        return { success: true, removed }
      } catch (error: any) {
        log.error('clear-partition-cookies 失败', { partition: payload.partition, error: error?.message })
        return { success: false, removed: 0, error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:check-login-status',
    async (_, payload: { partition: string; domain: string }) => {
      try {
        if (!isAllowedPartition(payload.partition)) {
          return { success: false, error: '不允许的 partition：不在白名单范围内' }
        }
        const partitionKey = payload.partition.startsWith('persist:')
          ? payload.partition
          : `persist:${payload.partition}`
        const ses = session.fromPartition(partitionKey)
        const cookies = await ses.cookies.get({ domain: payload.domain })
        const now = Math.floor(Date.now() / 1000)
        const validCookies = cookies.filter(
          c => !c.expirationDate || c.expirationDate > now
        )
        const hasSession = validCookies.some(
          c => c.httpOnly || ['sid', 'session', 'token', 'auth', 'jwt', 'access_token', 'sessionid', '_session_id'].some(k => c.name.toLowerCase().includes(k))
        )
        return {
          success: true,
          domain: payload.domain,
          hasCookies: validCookies.length > 0,
          cookieCount: validCookies.length,
          hasSessionCookie: hasSession,
        }
      } catch (error: any) {
        log.error('check-login-status 失败', { partition: payload.partition, error: error?.message })
        return { success: false, error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:export-cookies-json',
    async (_, payload: { partition: string }) => {
      try {
        if (!isAllowedPartition(payload.partition)) {
          return { success: false, error: '不允许的 partition：不在白名单范围内' }
        }
        const partitionKey = payload.partition.startsWith('persist:')
          ? payload.partition
          : `persist:${payload.partition}`
        const ses = session.fromPartition(partitionKey)
        const allCookies = await ses.cookies.get({})

        const confirm = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['导出', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '安全提示',
          message: `即将导出 ${allCookies.length} 条 Cookie`,
          detail: '导出的文件包含明文 Cookie 数据（含登录凭据），请妥善保管导出文件，切勿分享给他人。',
        })

        if (confirm.response !== 0) {
          log.info('export-cookies-json 用户取消', { partition: payload.partition })
          return { success: false, error: 'cancelled' }
        }

        const exportData = {
          version: '1.0',
          exported_at: new Date().toISOString(),
          partition: payload.partition,
          cookies: allCookies.map(c => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expirationDate || -1,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
            session: c.session,
          })),
        }

        const result = await dialog.showSaveDialog({
          defaultPath: `cookies-export-${Date.now()}.json`,
          filters: [{ name: 'JSON', extensions: ['json'] }],
        })

        if (result.canceled || !result.filePath) {
          log.info('export-cookies-json 未选择保存路径', { partition: payload.partition })
          return { success: false, error: 'cancelled' }
        }

        await writeFile(result.filePath, JSON.stringify(exportData, null, 2), 'utf-8')
        // 敏感数据导出（含明文 Cookie）：记录发生 + 数量 + 文件名（basename，不含家目录路径），不打内容
        log.warn('export-cookies-json 已导出明文 Cookie 文件', {
          partition: payload.partition,
          count: allCookies.length,
          fileName: result.filePath.split(sep).pop(),
        })
        return { success: true, path: result.filePath, count: allCookies.length }
      } catch (error: any) {
        log.error('export-cookies-json 失败', { partition: payload.partition, error: error?.message })
        return { success: false, error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:import-cookies-json',
    async () => {
      try {
        const result = await dialog.showOpenDialog({
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        })

        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'cancelled' }
        }

        const filePath = result.filePaths[0]
        const fileStat = await stat(filePath)
        if (fileStat.size > MAX_COOKIE_IMPORT_SIZE) {
          log.warn('import-cookies-json 文件过大被拒绝', { sizeBytes: fileStat.size })
          return { success: false, error: `文件过大（${(fileStat.size / 1024 / 1024).toFixed(1)}MB），上限 10MB` }
        }

        const raw = await readFile(filePath, 'utf-8')
        const data = JSON.parse(raw)

        let rawCookies: unknown[] = []

        if (data.version && Array.isArray(data.cookies)) {
          rawCookies = data.cookies
        } else if (Array.isArray(data)) {
          rawCookies = data.map((c: any) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            expires: c.expirationDate || c.expires || -1,
            httpOnly: c.httpOnly ?? false,
            secure: c.secure ?? false,
            sameSite: c.sameSite || 'Lax',
            session: c.session ?? false,
            size: ((c.name || '') + (c.value || '')).length,
          }))
        } else {
          return { success: false, error: '不支持的 JSON 格式' }
        }

        const cookies: Cookie[] = []
        let skipped = 0
        for (const entry of rawCookies) {
          if (isValidCookieEntry(entry)) {
            cookies.push(entry)
          } else {
            skipped++
          }
        }

        log.info('import-cookies-json 完成', { count: cookies.length, skipped })
        return { success: true, cookies, count: cookies.length, skipped }
      } catch (error: any) {
        log.error('import-cookies-json 失败', { error: error?.message })
        return { success: false, error: error.message }
      }
    }
  )

  guardedHandle(
    'credential-vault:extract-passwords',
    async (
      _,
      payload: {
        browser: string
        profilePath: string
      }
    ) => {
      try {
        const extractor = passwordExtractors[payload.browser]
        if (!extractor) {
          log.warn('extract-passwords 不支持的浏览器', { browser: payload.browser })
          return {
            success: false,
            passwords: [],
            error: `不支持从 ${payload.browser} 提取密码（仅支持 Chrome / Edge）`,
          }
        }
        if (!isAllowedProfilePath(payload.profilePath)) {
          log.warn('extract-passwords profile 路径被拒绝', { browser: payload.browser })
          return { success: false, passwords: [], error: '不允许的 profile 路径：必须位于已知浏览器 profile 目录中' }
        }

        // SS-33: 提取密码前需要用户明确确认，与 export-cookies 保持对称
        const confirm = await dialog.showMessageBox({
          type: 'warning',
          buttons: ['取消', '继续提取'],
          defaultId: 0,
          cancelId: 0,
          title: '安全提示',
          message: `即将从 ${payload.browser} 提取已保存的密码`,
          detail: '提取的密码将以明文形式返回，请确保操作安全，切勿将密码信息分享给他人或存储在不安全的位置。',
        })

        if (confirm.response !== 1) {
          log.info('extract-passwords 用户取消', { browser: payload.browser })
          return { success: false, passwords: [], error: 'cancelled' }
        }

        // 敏感操作：仅记录发起 + 浏览器类型 + 结果数量，绝不记录密码明文
        log.warn('extract-passwords 开始（用户已确认）', { browser: payload.browser })
        const result = await extractor.extractPasswords(payload.profilePath)
        const ok = (result as { success?: boolean })?.success !== false
        log.info('extract-passwords 完成', {
          browser: payload.browser,
          success: ok,
          count: (result as { passwords?: unknown[] })?.passwords?.length ?? 0,
          ...(ok ? {} : { error: (result as { error?: string })?.error }),
        })
        return result
      } catch (error: any) {
        log.error('extract-passwords 失败', { browser: payload.browser, error: error?.message })
        return { success: false, passwords: [], error: error.message }
      }
    }
  )

  registerAutofillHandlers()
  initAutofillService()

  log.info('IPC handlers 注册完成')
}

export function unregisterCredentialVaultHandlers(): void {
  ipcMain.removeHandler('credential-vault:detect-browsers')
  ipcMain.removeHandler('credential-vault:extract-cookies')
  ipcMain.removeHandler('credential-vault:inject-cookies')
  ipcMain.removeHandler('credential-vault:get-partition-cookies')
  ipcMain.removeHandler('credential-vault:clear-partition-cookies')
  ipcMain.removeHandler('credential-vault:check-login-status')
  ipcMain.removeHandler('credential-vault:export-cookies-json')
  ipcMain.removeHandler('credential-vault:import-cookies-json')
  ipcMain.removeHandler('credential-vault:extract-passwords')
  ipcMain.removeHandler('credential-vault:autofill-select')
  ipcMain.removeHandler('credential-vault:autofill-dismiss')
  // Wave 3 P0 视角 1#6：补 Wave 3 新增的 4 个 handler（开发期 hot reload /
  // 单测 cleanup 才不会"already registered" 抛错）
  ipcMain.removeHandler('credential-vault:password-captured')
  ipcMain.removeHandler('credential-vault:save-confirm')
  ipcMain.removeHandler('credential-vault:save-dismiss')
  ipcMain.removeHandler('credential-vault:save-undismiss')
}
