/**
 * TabSite route handler for CLI Server.
 *
 * Proxies requests to Django TabSite API (/api/tabsite/sites/).
 *
 * Routes:
 *   POST  /site/create             → POST   /api/tabsite/sites/
 *   GET   /site/list               → GET    /api/tabsite/sites/
 *   GET   /site/info/:id           → GET    /api/tabsite/sites/:id/
 *   PATCH /site/update/:id         → PATCH  /api/tabsite/sites/:id/
 *   POST  /site/publish/:id        → POST   /api/tabsite/sites/:id/publish/
 *   POST  /site/rollback/:id/:ver  → POST   /api/tabsite/sites/:id/rollback/:ver/
 *   POST  /site/init-template/:id  → copy template → PATCH /api/tabsite/sites/:id/
 *   GET   /site/build-info/:id     → GET    /api/tabsite/sites/:id/ (returns code_project_path)
 */

import http from 'node:http'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import nodePath from 'node:path'
import { randomUUID } from 'node:crypto'
import { okResponse } from '@tabtin/agent-wire'
import { getCLISpaceId, getCLIOrganizationId, getCLIOrganizationRoot } from '../cli-context'
import { djangoRequest, errorResponse, type SendJSON } from './shared/error-handler'
import { copyDirSafe, resolveTemplatePath, provisionTokenAndWriteEnv, hasValidTokenInEnvFile, fixWorkspaceDeps } from '../../utils/tabsite-helpers'
import { resolveDataRoot, resolveSpacesRoot } from '@tabtin/terminal-core'
import { resolveWorkspaceSiteDir } from '@tabtin/agent-runtime'
import { sanitizePathSegment } from '../../utils/path-sanitize'
import { createLogger } from '../../logger'
import { TokenManager } from '../../auth'

const log = createLogger('TabSiteCLI')

/**
 * ：解析当前登录用户的 userId（新布局 sites 目录必填字段，
 * 字段兼容与 ElectronAgentHost.resolveSkillUserId 同源）。
 */
async function resolveCurrentUserId(): Promise<string | undefined> {
  const userInfo = (await TokenManager.getUserInfo()) as
    | { id?: unknown; user_id?: unknown; userId?: unknown }
    | null
  const raw = userInfo?.id ?? userInfo?.user_id ?? userInfo?.userId
  if (raw === undefined || raw === null || raw === '') return undefined
  return String(raw)
}

function getSpaceId(body?: any): string | null {
  if (body?.space_id) return body.space_id
  return getCLISpaceId() || null
}

function getOrganizationId(body?: any): string | null {
  return body?.organization_id || process.env.TABTIN_ORGANIZATION_ID || getCLIOrganizationId() || null
}

// ── Route handler ────────────────────────────────────────

export async function handleTabsiteRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/site/, '')

  // ── Create site ────────────────────────────────────────

  if (route === '/create' && method === 'POST') {
    const spaceId = getSpaceId(body)
    if (!spaceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
      return
    }
    const organizationId = getOrganizationId(body)
    if (!organizationId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id'))
      return
    }
    if (!body?.name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name'))
      return
    }

    const result = await djangoRequest('POST', '/api/tabsite/sites/', {
      organization_id: organizationId,
      space_id: spaceId,
      name: body.name,
      description: body.description || '',
      framework: body.framework || 'react',
      template: body.template || 'blank',
    })
    sendJSON(res, result.status, result.data)
    return
  }

  // ── List sites ─────────────────────────────────────────

  if (route === '/list' && method !== 'GET') {
    sendJSON(res, 405, errorResponse('VALIDATION_ERROR', '/list 仅支持 GET 请求'))
    return
  }

  if (route === '/list') {
    const spaceId = getSpaceId(body)
    if (!spaceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
      return
    }
    const organizationId = getOrganizationId(body)
    if (!organizationId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 organization_id'))
      return
    }

    const qs = new URLSearchParams({
      organization_id: organizationId,
      space_id: spaceId,
      ...(body?.status && { status: body.status }),
      ...(body?.page && { page: String(body.page) }),
      ...(body?.page_size && { page_size: String(body.page_size) }),
    }).toString()
    const result = await djangoRequest('GET', `/api/tabsite/sites/?${qs}`)
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Update site ──────────────────────────────────────────

  const updateMatch = route.match(/^\/update\/([^/]+)$/)
  if (updateMatch && method === 'PATCH') {
    const siteId = updateMatch[1]
    if (!body || Object.keys(body).length === 0) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '至少需要提供一个要更新的字段'))
      return
    }
    const result = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, body)
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Site info (detail) ─────────────────────────────────

  const infoMatch = route.match(/^\/info\/([^/]+)$/)
  if (infoMatch && method !== 'GET') {
    sendJSON(res, 405, errorResponse('VALIDATION_ERROR', '/info 仅支持 GET 请求'))
    return
  }
  if (infoMatch) {
    const siteId = infoMatch[1]
    const result = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`)
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Publish site ───────────────────────────────────────

  const publishMatch = route.match(/^\/publish\/([^/]+)$/)
  if (publishMatch && method === 'POST') {
    const siteId = publishMatch[1]
    if (!body?.dist_url) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '必须提供 dist_url 参数。请先执行构建并上传，或手动提供产物地址。'))
      return
    }
    const result = await djangoRequest(
      'POST',
      `/api/tabsite/sites/${siteId}/publish/`,
      {
        message: body?.message || '',
        dist_url: body.dist_url,
        file_count: body?.file_count ?? 0,
        total_size: body?.total_size ?? 0,
      },
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Rollback site ──────────────────────────────────────

  const rollbackMatch = route.match(/^\/rollback\/([^/]+)\/([^/]+)$/)
  if (rollbackMatch && method === 'POST') {
    const [, siteId, versionStr] = rollbackMatch
    const version = parseInt(versionStr, 10)
    if (Number.isNaN(version) || version < 1) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'version 必须是正整数'))
      return
    }
    const result = await djangoRequest(
      'POST',
      `/api/tabsite/sites/${siteId}/rollback/${version}/`,
    )
    sendJSON(res, result.status, result.data)
    return
  }

  // ── Init template ───────────────────────────────────────

  const initMatch = route.match(/^\/init-template\/([^/]+)$/)
  if (initMatch && method === 'POST') {
    const siteId = initMatch[1]
    const spaceId = getSpaceId(body)
    if (!spaceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 space_id'))
      return
    }

    const siteResult = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`)
    if (siteResult.status !== 200 || !siteResult.data?.success) {
      sendJSON(res, siteResult.status, siteResult.data)
      return
    }
    const siteData = siteResult.data.data

    const userId = await resolveCurrentUserId()
    if (!userId) {
      sendJSON(res, 401, errorResponse('UNAUTHORIZED', '未登录，无法确定站点目录归属（缺少 userId）'))
      return
    }

    const safeSpaceId = sanitizePathSegment(spaceId)
    const safeSlug = sanitizePathSegment(siteData.slug || siteId)
    const organizationIdForSite =
      getCLIOrganizationId() ||
      (typeof siteData.organization_id === 'string' ? siteData.organization_id : '') ||
      ''
    if (!organizationIdForSite) {
      sendJSON(
        res,
        400,
        errorResponse(
          'VALIDATION_ERROR',
          '缺少 organization_id（ hard-cut — 禁止 _unscoped）',
        ),
      )
      return
    }
    const projectPath = resolveWorkspaceSiteDir(
      resolveDataRoot(),
      userId,
      organizationIdForSite,
      safeSpaceId,
      safeSlug,
    )

    if (fs.existsSync(projectPath) && fs.readdirSync(projectPath).length > 0) {
      if (!siteData.code_project_path) {
        const patchRes = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, {
          code_project_path: projectPath,
        })
        if (patchRes.status !== 200 || !patchRes.data?.success) {
          sendJSON(res, 200, errorResponse('PATCH_FAILED', `目录已存在但更新站点信息失败: ${patchRes.data?.error || patchRes.status}`, {
            detail: { code_project_path: projectPath },
          }))
          return
        }
      }

      // TDI-002: already_exists 分支也需要确保 .env.local 中有 Token
      let tokenProvisioned = false
      let tokenWarning: string | undefined
      let tokenExpiresSoon: boolean | undefined
      const existsTemplate = siteData.template || 'blank'
      if (existsTemplate === 'dashboard') {
        const envPath = nodePath.join(projectPath, '.env.local')
        let hasToken = false
        try {
          const content = await fsPromises.readFile(envPath, 'utf-8')
          hasToken = hasValidTokenInEnvFile(content)
        } catch { /* file doesn't exist */ }
        if (!hasToken) {
          const result = await provisionTokenAndWriteEnv(siteId, projectPath, { force: true })
          tokenProvisioned = result.tokenProvisioned
          tokenExpiresSoon = result.tokenExpiresSoon
          if (!tokenProvisioned) {
            tokenWarning = result.error || 'Token 恢复失败，站点数据功能可能不可用'
            log.warn(`already_exists 分支 Token 恢复失败 siteId=${siteId}:`, result.error)
          }
        } else {
          tokenProvisioned = true
        }
      }

      sendJSON(res, 200, okResponse({
        code_project_path: projectPath,
        already_exists: true,
        token_provisioned: tokenProvisioned,
        ...(tokenWarning && { token_warning: tokenWarning }),
        ...(tokenExpiresSoon && { token_expires_soon: true }),
      }))
      return
    }

    const template = siteData.template || 'blank'
    const templateDir = resolveTemplatePath(template)
    if (!templateDir) {
      sendJSON(res, 404, errorResponse('NOT_FOUND', `模板 "${template}" 未找到`))
      return
    }

    await fsPromises.mkdir(projectPath, { recursive: true })
    try {
      await copyDirSafe(templateDir, projectPath)
    } catch (copyErr: any) {
      await fsPromises.rm(projectPath, { recursive: true, force: true }).catch(() => {})
      sendJSON(res, 500, errorResponse('COPY_FAILED', `模板复制失败: ${copyErr.message}`))
      return
    }

    await fixWorkspaceDeps(projectPath)

    const patchResult = await djangoRequest('PATCH', `/api/tabsite/sites/${siteId}/`, {
      code_project_path: projectPath,
    })
    if (patchResult.status !== 200 || !patchResult.data?.success) {
      sendJSON(res, 200, errorResponse('PATCH_FAILED', `模板已复制到 ${projectPath}，但更新站点信息失败: ${patchResult.data?.error || patchResult.status}`, {
        detail: { code_project_path: projectPath },
      }))
      return
    }

    let tokenProvisioned = false
    let tokenWarning: string | undefined
    let tokenExpiresSoon: boolean | undefined
    if (template === 'dashboard') {
      const result = await provisionTokenAndWriteEnv(siteId, projectPath)
      tokenProvisioned = result.tokenProvisioned
      tokenExpiresSoon = result.tokenExpiresSoon
      if (!tokenProvisioned) {
        tokenWarning = result.error || 'Token 配置失败，站点数据功能可能不可用'
        log.warn(`Token 自动配置失败 siteId=${siteId}:`, result.error)
      }
    }

    sendJSON(res, 200, okResponse({
      code_project_path: projectPath,
      template,
      token_provisioned: tokenProvisioned,
      ...(tokenWarning && { token_warning: tokenWarning }),
      ...(tokenExpiresSoon && { token_expires_soon: true }),
    }))
    return
  }

  // ── Upload dist ───────────────────────────────────────
  const uploadMatch = route.match(/^\/upload-dist\/([^/]+)$/)
  if (uploadMatch && method === 'POST') {
    const siteId = uploadMatch[1]
    const distPath = body?.dist_path
    if (!distPath) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 dist_path'))
      return
    }

    if (!fs.existsSync(distPath)) {
      sendJSON(res, 400, errorResponse('DIST_NOT_FOUND', `构建产物目录不存在: ${distPath}`))
      return
    }

    const resolvedDist = nodePath.resolve(distPath)
    // Allow publish from anywhere in user workspace or dataRoot site dirs
    // (：site 项目已硬切到 `{dataRoot}/users/{userId}/…/sites/`，
    // 不再落 legacy platform-data 树)。
    const allowedRoots: string[] = [
      nodePath.resolve(resolveSpacesRoot()),
      nodePath.resolve(resolveDataRoot()),
    ]
    const organizationRoot = getCLIOrganizationRoot()
    if (organizationRoot) allowedRoots.push(nodePath.resolve(organizationRoot))
    const isWithinAllowed = allowedRoots.some(
      (root) => resolvedDist === root || resolvedDist.startsWith(root + nodePath.sep),
    )
    if (!isWithinAllowed) {
      sendJSON(
        res,
        403,
        errorResponse('PERMISSION_DENIED', 'dist_path 必须位于 TabTin 工作区或沙盒目录内'),
      )
      return
    }

    const siteResult = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`)
    if (siteResult.status !== 200 || !siteResult.data?.success) {
      sendJSON(res, siteResult.status, siteResult.data)
      return
    }
    const siteData = siteResult.data.data
    const uploadId = randomUUID().slice(0, 8)
    const folder = `tabsite/sites/${siteId}/${uploadId}`

    const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024
    const skippedFiles: string[] = []
    const files: Array<{ relativePath: string; absolutePath: string; size: number }> = []
    async function collectFiles(dir: string, base: string) {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const fullPath = nodePath.join(dir, entry.name)
        const relPath = nodePath.join(base, entry.name)
        const normalizedRel = relPath.replace(/\\/g, '/')
        if (normalizedRel.split('/').includes('..')) {
          skippedFiles.push(normalizedRel)
          continue
        }
        if (entry.isDirectory()) {
          await collectFiles(fullPath, relPath)
        } else {
          const stat = await fsPromises.stat(fullPath)
          if (stat.size > MAX_SINGLE_FILE_SIZE) {
            skippedFiles.push(`${normalizedRel} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`)
            continue
          }
          files.push({ relativePath: relPath, absolutePath: fullPath, size: stat.size })
        }
      }
    }
    await collectFiles(distPath, '')

    if (files.length === 0) {
      sendJSON(res, 400, errorResponse('EMPTY_DIST', '构建产物目录为空'))
      return
    }

    const UPLOAD_TIMEOUT_MIN_MS = 60_000
    const UPLOAD_BYTES_PER_SEC = 50 * 1024 // 50 KB/s conservative baseline
    let uploadedCount = 0
    let totalSize = 0
    const uploadedKeys: string[] = []
    const failedFiles: Array<{ path: string; error: string }> = []

    // DVC-005: compute cdnBaseUrl deterministically from ENV + folder,
    // not from cdn_url (which differs for instant-upload / deduped files)
    let cdnBaseUrl = ''
    const cdnDomain = process.env.TABTIN_CDN_DOMAIN || process.env.ALIYUN_OSS_CDN_DOMAIN || ''
    if (cdnDomain) {
      cdnBaseUrl = `https://${cdnDomain}/${folder}`
    } else {
      const ossDomain = process.env.ALIYUN_OSS_ENDPOINT || process.env.TABTIN_OSS_DOMAIN || ''
      const bucket = process.env.ALIYUN_OSS_BUCKET || ''
      if (ossDomain && bucket) {
        cdnBaseUrl = `https://${bucket}.${ossDomain}/${folder}`
      }
    }

    const contentTypeMap: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
      '.ico': 'image/x-icon',
      '.webp': 'image/webp',
      '.map': 'application/json',
      '.txt': 'text/plain',
    }

    async function uploadOne(file: { relativePath: string; absolutePath: string; size: number }) {
      const relPath = file.relativePath.replace(/\\/g, '/')
      const baseName = nodePath.basename(relPath)
      const ext = nodePath.extname(baseName).toLowerCase()
      const contentType = contentTypeMap[ext] || 'application/octet-stream'
      const objectKey = `${folder}/${relPath}`

      const presignResult = await djangoRequest('POST', '/api/services/oss/presign-upload', {
        filename: baseName,
        folder,
        content_type: contentType,
        file_size: file.size,
        organization_id: siteData.organization_id || getOrganizationId(body),
        object_key: objectKey,
        module: 'tabsite',
        context_type: 'site',
        context_id: siteId,
        is_public: true,
      })

      if (presignResult.status !== 200 || !presignResult.data?.success) {
        throw new Error(`Presign 失败: ${relPath} — ${presignResult.data?.message || ''}`)
      }

      const presignData = presignResult.data.data
      if (!presignData.instant) {
        const fileBuffer = await fsPromises.readFile(file.absolutePath)
        // DVC-012: dynamic timeout based on file size
        const dynamicTimeoutMs = Math.max(UPLOAD_TIMEOUT_MIN_MS, Math.ceil(file.size / UPLOAD_BYTES_PER_SEC) * 1000)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), dynamicTimeoutMs)
        try {
          const putResp = await fetch(presignData.presigned_url, {
            method: 'PUT',
            headers: { 'Content-Type': presignData.content_type || contentType },
            body: fileBuffer,
            signal: controller.signal,
          })
          if (!putResp.ok) {
            throw new Error(`OSS PUT 失败: ${relPath} (HTTP ${putResp.status})`)
          }
        } finally {
          clearTimeout(timer)
        }

        const confirmResult = await djangoRequest('POST', '/api/services/oss/confirm-upload', {
          object_key: presignData.object_key,
          file_name: baseName,
          file_size: file.size,
          content_type: contentType,
          module: 'tabsite',
          context_type: 'site',
          context_id: siteId,
          organization_id: siteData.organization_id || getOrganizationId(body),
          is_public: true,
        })
        if (confirmResult.status !== 200 || !confirmResult.data?.success) {
          throw new Error(`Confirm 失败: ${relPath} — ${confirmResult.data?.message || ''}`)
        }
      }

      uploadedKeys.push(presignData.object_key || objectKey)

      // DVC-005: if cdnBaseUrl wasn't resolved from ENV, try extracting from response
      if (!cdnBaseUrl) {
        const url = presignData.cdn_url || presignData.access_url || ''
        if (url) {
          try {
            const urlObj = new URL(url)
            cdnBaseUrl = `${urlObj.origin}/${folder}`
          } catch { /* ignore malformed URLs */ }
        }
      }

      uploadedCount++
      totalSize += file.size
    }

    // DVC-012: single file failure continues; errors collected and reported at end
    const CONCURRENCY = 5
    for (let i = 0; i < files.length; i += CONCURRENCY) {
      const batch = files.slice(i, i + CONCURRENCY)
      const results = await Promise.allSettled(batch.map(uploadOne))
      for (let j = 0; j < results.length; j++) {
        const r = results[j]
        if (r.status === 'rejected') {
          failedFiles.push({
            path: batch[j].relativePath,
            error: r.reason?.message || String(r.reason),
          })
        }
      }
      const done = Math.min(i + CONCURRENCY, files.length)
      if (files.length > CONCURRENCY) {
        log.debug(`上传进度: ${done}/${files.length}`)
      }
    }

    if (failedFiles.length > 0 && uploadedCount === 0) {
      sendJSON(res, 500, errorResponse('UPLOAD_FAILED', `全部 ${failedFiles.length} 个文件上传失败`, {
        detail: {
          failed_files: failedFiles,
          total_files: files.length,
          skipped_files: skippedFiles,
        },
      }))
      return
    }

    const distUrl = cdnBaseUrl ? `${cdnBaseUrl}/` : ''

    if (!distUrl) {
      sendJSON(res, 500, errorResponse('UNAVAILABLE', '上传成功但无法推导 dist_url，请检查 CDN/OSS 域名环境变量（TABTIN_CDN_DOMAIN 或 ALIYUN_OSS_CDN_DOMAIN）', {
        detail: {
          uploaded_keys: uploadedKeys,
          uploaded_count: uploadedCount,
        },
      }))
      return
    }

    sendJSON(res, 200, okResponse({
      dist_url: distUrl,
      file_count: uploadedCount,
      total_size: totalSize,
      ...(skippedFiles.length > 0 && { skipped_files: skippedFiles }),
      ...(failedFiles.length > 0 && { failed_files: failedFiles }),
    }))
    return
  }

  // ── Build info (code_project_path for client-side build) ──

  const buildInfoMatch = route.match(/^\/build-info\/([^/]+)$/)
  if (buildInfoMatch) {
    const siteId = buildInfoMatch[1]
    const result = await djangoRequest('GET', `/api/tabsite/sites/${siteId}/`)
    if (result.status !== 200 || !result.data?.success) {
      sendJSON(res, result.status, result.data)
      return
    }
    const site = result.data.data
    sendJSON(res, 200, okResponse({
      id: site?.id,
      name: site?.name,
      code_project_path: site?.code_project_path || null,
      framework: site?.framework,
    }))
    return
  }

  // ── Fallback ───────────────────────────────────────────

  sendJSON(res, 404, errorResponse('NOT_FOUND', `Unknown site route: ${url}`))
}
