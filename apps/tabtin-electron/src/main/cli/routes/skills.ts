/**
 * Skills route handler for Electron CLI Server.
 *
 * Wave 1：与 Daemon 对齐——代理 Django `/skills/{key}/enable|disable`，
 * enable 成功后按 source 物化本地文件（app → materializeAppSkill；
 * user+package_id → Package Registry 下载）。
 */

import http from 'node:http'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  installSkillFromBundle,
  uninstallSkillLocal,
  isValidSkillKey,
  type PackageRegistryFile,
} from '@tabtin/agent-host/skills'
import { parseAppSkillCanonicalKey } from '@tabtin/agent-runtime/skills'
import {
  resolveDataRoot,
  resolveOrganizationSkillDir,
  resolveUserSkillDir,
} from '@tabtin/terminal-core'
import {
  getCLIOrganizationId,
  getCLISkillsMaterializer,
  getCLISkillsInteropAdder,
} from '../cli-context'
import { djangoRequest, errorResponse, type SendJSON } from './shared/error-handler'
import { createLogger } from '../../logger'
import { handleSkillImport, handleSkillInstallNpm } from './skill-import-npm'
import { TokenManager } from '../../auth'

const log = createLogger('CLISkills')
const LOG_TAG = '[CLI Skills]'

/** ：CLI 本地 skill 落盘必须有真实 userId，禁止 `_unscoped`。 */
async function requireCLISkillUserId(): Promise<string> {
  const userInfo = await TokenManager.getUserInfo()
  const raw =
    (userInfo?.id as unknown) ??
    (userInfo?.user_id as unknown) ??
    (userInfo?.userId as unknown)
  if (raw === undefined || raw === null || raw === '') {
    throw new Error('未登录：无法解析 userId，拒绝写入本地 skills 目录')
  }
  const userId = String(raw)
  if (userId === '_unscoped') {
    throw new Error('非法 userId=_unscoped，拒绝写入本地 skills 目录')
  }
  return userId
}

function fullyDecodeURIComponent(str: string): string {
  let prev = str
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const decoded = decodeURIComponent(prev)
      if (decoded === prev) return decoded
      prev = decoded
    } catch {
      return prev
    }
  }
}

function normalizeIdField(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    /[\x00-\x1F\x7F]/.test(trimmed)
  ) {
    return null
  }
  return trimmed
}

/** ：优先从 body 读 organization_id；缺失时回退 CLI context 的活跃组织。 */
function getBodyOrganizationId(body: any): string | null {
  return (
    normalizeIdField(body?.organization_id) ??
    normalizeIdField(body?.organizationId) ??
    normalizeIdField(getCLIOrganizationId())
  )
}

/** 兼容：本地物化仍用 spaceId 定位 sandbox（组织级 enablement 不改变本地目录布局）。 */
function getBodySpaceId(body: any): string | null {
  return normalizeIdField(body?.space_id) ?? normalizeIdField(body?.spaceId)
}

function missingOrganizationResponse(action: 'enable' | 'disable') {
  const verb = action === 'enable' ? '启用' : '禁用'
  return errorResponse('VALIDATION_ERROR', `缺少有效的 organization_id，无法${verb} skill`, {
    suggestions: [
      '请在请求中传入当前 Organization 的 organization_id',
      '或先通过 `tabtin auth login` / 环境变量设置活跃组织',
    ],
  })
}

function withCanonicalOrganizationId(body: any, organizationId: string): any {
  if (!body || typeof body !== 'object') {
    return { organization_id: organizationId }
  }
  const next = { ...body, organization_id: organizationId }
  // 清理旧字段，避免后端同时收到 space_id 后按 legacy 分支处理。
  delete next.space_id
  delete next.spaceId
  return next
}

function unwrapDjangoData(djangoData: any): any {
  return djangoData?.data ?? djangoData
}

function localSkillSlugFromCanonicalKey(canonicalKey: string): string {
  const slug = canonicalKey.includes(':')
    ? canonicalKey.split(':').slice(1).join(':')
    : canonicalKey
  if (!isValidSkillKey(slug)) {
    throw new Error(`无效的本地 skill slug: ${canonicalKey}`)
  }
  return slug
}

async function getLocalSkillDirState(targetDir: string): Promise<'directory' | 'missing'> {
  try {
    const stat = await fsp.stat(targetDir)
    if (!stat.isDirectory()) {
      throw new Error(`本地 skill 路径不是目录: ${targetDir}`)
    }
    return 'directory'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing'
    }
    throw err
  }
}

async function fetchPackageVersionFiles(
  packageId: string,
  versionSeq: number,
): Promise<{
  version_seq: number
  version_label?: string | null
  bundle_sha256?: string | null
  files: PackageRegistryFile[]
}> {
  const result = await djangoRequest(
    'GET',
    `/api/services/package-registry/packages/${packageId}/versions/${versionSeq}/files`,
    undefined,
    { logTag: LOG_TAG },
  )
  if (result.status < 200 || result.status >= 300) {
    const msg = (result.data as any)?.message ?? `HTTP ${result.status}`
    throw new Error(`拉取 Package Registry 文件失败: ${msg}`)
  }
  const data = unwrapDjangoData(result.data)
  if (!data?.files?.length) {
    throw new Error('Package Registry 未返回可下载文件')
  }
  return data
}

async function postEnableMaterialize(
  canonicalKey: string,
  djangoData: any,
  body: any,
): Promise<void> {
  const data = unwrapDjangoData(djangoData)
  const spaceId = getBodySpaceId(body)
  if (!spaceId) {
    throw new Error('缺少有效的 space_id，无法将 skill 物化到 Space sandbox')
  }

  const source = String(data?.source ?? canonicalKey.split(':')[0] ?? '').toLowerCase()
  const organizationId = getCLIOrganizationId() ?? undefined

  if (source === 'app') {
    const coords = parseAppSkillCanonicalKey(canonicalKey)
    if (!coords) {
      throw new Error(`无法解析 app skill canonical key: ${canonicalKey}`)
    }
    if (!organizationId) {
      throw new Error('缺少 organizationId，无法物化 app skill')
    }
    const materializer = getCLISkillsMaterializer()
    if (!materializer) {
      throw new Error('Skill materializer 未注入（ElectronAgentHost 未就绪）')
    }
    const result = await materializer({
      organizationId,
      spaceId,
      userId: await requireCLISkillUserId(),
      appId: coords.appId,
      slug: coords.slug,
    })
    if (result.errors.length > 0 && result.installed === 0) {
      throw new Error(result.errors.join('; '))
    }
    log.info(
      `App skill materialized app=${coords.appId} slug=${coords.slug} installed=${result.installed}`,
    )
    return
  }

  if (source === 'user') {
    const packageId = data?.package_id
    const versionSeq = data?.installed_version_seq
    if (!packageId || !versionSeq) {
      log.info(`user skill ${canonicalKey} 无 package/version，跳过本地物化`)
      return
    }
    const bundle = await fetchPackageVersionFiles(String(packageId), Number(versionSeq))
    const skillKey = localSkillSlugFromCanonicalKey(canonicalKey)
    const userId = await requireCLISkillUserId()
    // ：新布局 user/org skills；缺失 organizationId 时落到 user skills。
    const targetDir = organizationId
      ? resolveOrganizationSkillDir(resolveDataRoot(), userId, organizationId, skillKey)
      : resolveUserSkillDir(resolveDataRoot(), userId, skillKey)
    const result = await installSkillFromBundle({
      skillKey,
      files: bundle.files,
      targetDir,
      meta: {
        source: 'user',
        version: bundle.version_label ?? String(bundle.version_seq),
        installedAt: new Date().toISOString(),
        packageId: String(packageId),
        versionSeq: bundle.version_seq,
        bundleSha256: bundle.bundle_sha256 ?? undefined,
      },
    })
    if (!result.ok) {
      throw new Error(result.error ?? '本地 skill bundle 安装失败')
    }
    log.info(`Bundle installed to ${targetDir} (${result.filesWritten} files)`)
  }
}

async function postDisableCleanup(
  canonicalKey: string,
  body: any,
): Promise<void> {
  if (!body?.remove) return

  const spaceId = getBodySpaceId(body)
  if (!spaceId) {
    throw new Error('缺少有效的 space_id，无法从 Space sandbox 删除 skill')
  }

  const source = canonicalKey.split(':')[0]?.toLowerCase() ?? ''
  let skillKey: string
  if (source === 'app') {
    const coords = parseAppSkillCanonicalKey(canonicalKey)
    if (!coords) return
    skillKey = `${coords.appId}-${coords.slug}`
  } else if (source === 'user') {
    skillKey = localSkillSlugFromCanonicalKey(canonicalKey)
  } else {
    return
  }

  const userId = await requireCLISkillUserId()
  const orgId = getCLIOrganizationId() ?? undefined
  const targetDir = orgId
    ? resolveOrganizationSkillDir(resolveDataRoot(), userId, orgId, skillKey)
    : resolveUserSkillDir(resolveDataRoot(), userId, skillKey)
  const localState = await getLocalSkillDirState(targetDir)
  if (localState === 'missing') return

  const removed = await uninstallSkillLocal(targetDir)
  if (!removed) {
    throw new Error(`本地 skill 目录删除失败: ${targetDir}`)
  }
  log.info(`Local skill dir removed: ${targetDir}`)
}

function matchEnableDisable(
  method: string,
  normalized: string,
): { action: 'enable' | 'disable'; canonicalKey: string } | null {
  if (method !== 'POST') return null
  const m = /^\/(.+)\/(enable|disable)$/.exec(normalized)
  if (!m) return null
  const canonicalKey = fullyDecodeURIComponent(m[1])
  if (!canonicalKey || canonicalKey.includes('..')) return null
  return { action: m[2] as 'enable' | 'disable', canonicalKey }
}

export async function handleSkillsRoute(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/skills/, '')

  if (route && route !== '/') {
    const queryIndex = route.indexOf('?')
    const pathPart = queryIndex >= 0 ? route.substring(0, queryIndex) : route
    const queryPart = queryIndex >= 0 ? route.substring(queryIndex) : ''

    const fullyDecoded = fullyDecodeURIComponent(pathPart)
    if (fullyDecoded.includes('..') || !fullyDecoded.startsWith('/')) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '非法路由路径'))
      return
    }
    const normalized = path.posix.normalize(fullyDecoded)
    if (normalized.includes('..') || !normalized.startsWith('/')) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '非法路由路径'))
      return
    }

    // ：本地导入 / npm 安装（不走 Django 同名路径代理）
    if (method === 'POST' && normalized === '/import') {
      await handleSkillImport({
        body,
        organizationId: getCLIOrganizationId(),
        sendJSON,
        res,
      })
      return
    }
    if (method === 'POST' && (normalized === '/install-npm' || normalized === '/npm-install')) {
      const adder = getCLISkillsInteropAdder()
      await handleSkillInstallNpm({
        body,
        organizationId: getCLIOrganizationId(),
        sendJSON,
        res,
        addInteropRoot: adder ?? undefined,
      })
      return
    }

    const enableDisable = matchEnableDisable(method, normalized)
    // ：Django enable/disable 锚点从 space_id 迁到 organization_id；
    // body 未带 organization_id 时回退 CLI 活跃组织（getBodyOrganizationId 内已兜底）。
    const organizationId = enableDisable ? getBodyOrganizationId(body) : null
    const spaceId = enableDisable ? getBodySpaceId(body) : null

    if (enableDisable && !organizationId) {
      sendJSON(res, 400, missingOrganizationResponse(enableDisable.action))
      return
    }

    const djangoBody = enableDisable && organizationId
      ? withCanonicalOrganizationId(body, organizationId)
      : body
    const djangoPath = `/api/skills${normalized}${queryPart}`
    const result = await djangoRequest(method, djangoPath, djangoBody, { logTag: LOG_TAG })

    if (enableDisable && organizationId && result.status >= 200 && result.status < 300) {
      try {
        if (enableDisable.action === 'enable') {
          // 本地物化仍以 spaceId 定位本机 sandbox；缺 spaceId 时跳过本地物化，
          // 只保留云端 enablement（组织级），符合  「组织为权威、设备端为副本」。
          if (spaceId) {
            const materializeBody = spaceId ? { ...djangoBody, space_id: spaceId } : djangoBody
            await postEnableMaterialize(enableDisable.canonicalKey, result.data, materializeBody)
          } else {
            log.info(`skip local materialize: no space_id in body (canonicalKey=${enableDisable.canonicalKey})`)
          }
        } else {
          if (spaceId) {
            await postDisableCleanup(enableDisable.canonicalKey, { ...djangoBody, space_id: spaceId })
          }
        }
      } catch (err) {
        // ：本机装包失败不再回滚后端总闸；返回 200 + warning，避免半启用状态。
        log.warn('local materialize/cleanup error (not fatal):', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        const rawResult: any = result.data
        const rawInner: any = rawResult && typeof rawResult === 'object' && 'data' in rawResult
          ? (rawResult as { data?: unknown }).data ?? rawResult
          : rawResult
        const merged = {
          ...(typeof rawInner === 'object' && rawInner ? rawInner : {}),
          warning: enableDisable.action === 'enable'
            ? `local_install:failed ${errMsg}`
            : `local_uninstall:failed ${errMsg}`,
          detail: {
            local_install: enableDisable.action === 'enable' ? 'failed' : undefined,
            local_uninstall: enableDisable.action === 'disable' ? 'failed' : undefined,
            error_message: errMsg,
          },
        }
        // 保持 envelope 结构：如果原返回带 ok/data 外壳，包回去；否则原样。
        if (rawResult && typeof rawResult === 'object' && 'ok' in rawResult) {
          result.data = { ...rawResult, data: merged }
        } else {
          result.data = merged as any
        }
      }
    }

    sendJSON(res, result.status, result.data)
    return
  }

  sendJSON(
    res,
    404,
    errorResponse('UNKNOWN_ROUTE', `未知的 Skill 路由: ${url}`, {
      suggestions: ['请检查命令拼写', '使用 tabtin skill --help 查看可用命令'],
    }),
  )
}
