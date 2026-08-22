import fsp from 'node:fs/promises'

import {
  installSkillFromBundle,
  isValidSkillKey,
  uninstallSkillLocal,
  type PackageRegistryFile,
} from '@tabtin/agent-host/skills'
import { parseAppSkillCanonicalKey } from '@tabtin/agent-runtime/skills'
import {
  resolveDataRoot,
  resolveOrganizationSkillDir,
  resolveUserSkillDir,
} from '@tabtin/terminal-core'

export interface SkillEnablementContext {
  organizationId?: string
  requireUserId(): string
  request(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }>
  materializeApp(input: {
    organizationId: string
    spaceId: string
    userId: string
    appId: string
    slug: string
  }): Promise<{ installed: number; errors: string[] }>
}

function unwrap(data: any): any {
  return data?.data ?? data
}

function localSlug(canonicalKey: string): string {
  const slug = canonicalKey.includes(':') ? canonicalKey.split(':').slice(1).join(':') : canonicalKey
  if (!isValidSkillKey(slug)) throw new Error(`无效的本地 skill slug: ${canonicalKey}`)
  return slug
}

function targetDir(context: SkillEnablementContext, skillKey: string): string {
  const userId = context.requireUserId()
  return context.organizationId
    ? resolveOrganizationSkillDir(resolveDataRoot(), userId, context.organizationId, skillKey)
    : resolveUserSkillDir(resolveDataRoot(), userId, skillKey)
}

export async function materializeEnabledSkill(input: {
  canonicalKey: string
  djangoData: any
  spaceId: string
  context: SkillEnablementContext
}): Promise<{ installed: boolean; skipped?: string }> {
  const data = unwrap(input.djangoData)
  const source = String(data?.source ?? input.canonicalKey.split(':')[0] ?? '').toLowerCase()
  if (source === 'app') {
    const coords = parseAppSkillCanonicalKey(input.canonicalKey)
    if (!coords) throw new Error(`无法解析 app skill canonical key: ${input.canonicalKey}`)
    if (!input.context.organizationId) throw new Error('缺少 organizationId，无法物化 app skill')
    const result = await input.context.materializeApp({
      organizationId: input.context.organizationId,
      spaceId: input.spaceId,
      userId: input.context.requireUserId(),
      appId: coords.appId,
      slug: coords.slug,
    })
    if (result.errors.length > 0 && result.installed === 0) throw new Error(result.errors.join('; '))
    return { installed: result.installed > 0 }
  }
  if (source !== 'user') return { installed: false, skipped: `unsupported source: ${source}` }
  const packageId = data?.package_id
  const versionSeq = data?.installed_version_seq
  if (!packageId || !versionSeq) return { installed: false, skipped: 'missing package version' }
  const response = await input.context.request(
    'GET',
    `/api/services/package-registry/packages/${packageId}/versions/${versionSeq}/files`,
  )
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`拉取 Package Registry 文件失败: ${(response.data as any)?.message ?? `HTTP ${response.status}`}`)
  }
  const bundle = unwrap(response.data) as {
    version_seq: number
    version_label?: string | null
    bundle_sha256?: string | null
    files: PackageRegistryFile[]
  }
  if (!bundle.files?.length) throw new Error('Package Registry 未返回可下载文件')
  const skillKey = localSlug(input.canonicalKey)
  const destination = targetDir(input.context, skillKey)
  const result = await installSkillFromBundle({
    skillKey,
    files: bundle.files,
    targetDir: destination,
    meta: {
      source: 'user',
      version: bundle.version_label ?? String(bundle.version_seq),
      installedAt: new Date().toISOString(),
      packageId: String(packageId),
      versionSeq: bundle.version_seq,
      bundleSha256: bundle.bundle_sha256 ?? undefined,
    },
  })
  if (!result.ok) throw new Error(result.error ?? '本地 skill bundle 安装失败')
  return { installed: true }
}

export async function cleanupDisabledSkill(input: {
  canonicalKey: string
  remove: boolean
  context: SkillEnablementContext
}): Promise<{ removed: boolean }> {
  if (!input.remove) return { removed: false }
  const source = input.canonicalKey.split(':')[0]?.toLowerCase() ?? ''
  let skillKey: string
  if (source === 'app') {
    const coords = parseAppSkillCanonicalKey(input.canonicalKey)
    if (!coords) return { removed: false }
    skillKey = `${coords.appId}-${coords.slug}`
  } else if (source === 'user') {
    skillKey = localSlug(input.canonicalKey)
  } else {
    return { removed: false }
  }
  const destination = targetDir(input.context, skillKey)
  try {
    const stat = await fsp.stat(destination)
    if (!stat.isDirectory()) throw new Error(`本地 skill 路径不是目录: ${destination}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: false }
    throw error
  }
  if (!await uninstallSkillLocal(destination)) throw new Error(`本地 skill 目录删除失败: ${destination}`)
  return { removed: true }
}
