/**
 * Skills react-query hooks（Wave 1，PRD V3.3）。
 *
 * Wave 1 重构：
 * - built-in catalog 从本地 `skill:list` 读取；backend `/skills/visible` 只补
 *   user / marketplace / config 等后端权威数据
 * - 状态变更端点使用 `/skills/{key}/enable` / `/skills/{key}/disable`
 * - backend-owned package Skills 在 enable/disable 成功后同步写入/删除本地
 *   Space sandbox，避免 UI 只改 Django 状态但 Agent runtime 读不到文件。
 * - `useSkillConfigsQuery` 改读 SkillEnablement.config_json（API 形态保持兼容）
 *
 * HTTP 通道：本文件统一走 `electronFetch`（services/electronFetch.ts）→
 * 主进程 IPC 代理 → renderer fetch，自动获得 token 注入与统一错误协议。
 * contract Wave 1 禁止 renderer 端裸 fetch 拼 API URL，详见
 * eslint-rules/no-direct-fetch-in-renderer.js。
 */
import { joinApiPath } from '@tabtin/config'
import { useMemo } from 'react'
import {
  keepPreviousData,
  useQuery,
  useQueries,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from '@tanstack/react-query'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { useAuthStore } from '@/stores/useAuthStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { electronFetch } from '@/services/electronFetch'
import { invalidateSkillEnablementCache } from '@/services/skillEnablementCacheApi'
import { createLogger } from '@/utils/logger'
import { resolveOrganizationId } from '@/hooks/useResolvedOrganizationId'
import type {
  AgentDefinition,
  AgentSkillLinkItem,
  SkillIndexEntry,
  SkillConfig,
  SkillConfigUpdatePayload,
  SkillCreatePayload,
  SkillPublishPayload,
  SkillActivateVersionPayload,
  PackageVersion,
  SkillVersion,
  SkillUpgradePayload,
  SkillUpgradeResult,
  SkillImportPayload,
  SkillImportResult,
  SkillQuickUsePreset,
} from '@/skills/types'
import { normalizeSkillSource } from '@/skills/types'
import { mergeSkillCatalogEntries } from '@/skills/skillCatalogIdentity'
import { localSkillMdExists } from '@/components/context-space/skills/skillSkeletonDetect'
import { mapWorkspaceScanToSkillIndexEntry } from '@/components/context-space/skills/workspaceSkillScan'
import {
  generateSkillSkeleton,
  writeSkillContent,
} from '@/components/context-space/skills/skillMdUtils'

/** 稳定空引用：避免 `?? []` 每渲染新建数组触发下游 useMemo 死循环。 */
const EMPTY_WORKSPACE_SCAN_SKILLS: Array<{
  key: string
  slug: string
  name: string
  display_name?: string
  description?: string
  emoji?: string
  rel_path?: string
  doc_path?: string
}> = []

/** ：与 agent-host 的临时隐藏列表保持一致，避免 UI 暴露不可执行的 App Skill。 */
const TEMPORARILY_HIDDEN_SKILL_APP_IDS = new Set([
  'tabsite',
])

function isTemporarilyHiddenSkill(skill: {
  skill_key?: string
  app_id?: string | null
}): boolean {
  const key = skill.skill_key || ''
  const keyAppId = key.startsWith('app:')
    ? key.slice('app:'.length).split('/', 1)[0]
    : undefined
  return TEMPORARILY_HIDDEN_SKILL_APP_IDS.has(skill.app_id ?? '')
    || (keyAppId !== undefined && TEMPORARILY_HIDDEN_SKILL_APP_IDS.has(keyAppId))
}

const log = createLogger('Skills')

class LocalRuntimeSkillCatalogError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'LocalRuntimeSkillCatalogError'
    if (options && 'cause' in options) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

class LocalRuntimeSkillIpcUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalRuntimeSkillIpcUnavailableError'
  }
}

function isLocalRuntimeSkillCatalogError(error: unknown): boolean {
  return error instanceof LocalRuntimeSkillCatalogError
    || (error instanceof Error && error.name === 'LocalRuntimeSkillCatalogError')
}

function isLocalRuntimeSkillIpcUnavailableError(error: unknown): boolean {
  return error instanceof LocalRuntimeSkillIpcUnavailableError
    || (error instanceof Error && error.name === 'LocalRuntimeSkillIpcUnavailableError')
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const skillKeys = {
  all: ['skills'] as const,
  /**
   * ：目录默认锚 organizationId；显式 agentId 时（ 斜杠携带态）进 key。
   * spaceId 仅本地 IPC 用，不进 key。仅 organizationId 时供 invalidate 前缀匹配。
   */
  list: (organizationId: string, agentId?: string | null) => {
    if (agentId !== undefined && agentId !== null) {
      return [...skillKeys.all, 'list', organizationId, agentId] as const
    }
    return [...skillKeys.all, 'list', organizationId] as const
  },
  visible: (organizationId: string, agentId?: string | null) =>
    agentId
      ? [...skillKeys.all, 'visible', organizationId, agentId] as const
      : [...skillKeys.all, 'visible', organizationId] as const,
  configs: (organizationId: string, agentId?: string | null) =>
    agentId
      ? [...skillKeys.all, 'configs', organizationId, agentId] as const
      : [...skillKeys.all, 'configs', organizationId] as const,
  content: (skillKey: string) => [...skillKeys.all, 'content', skillKey] as const,
  versions: (packageId: string) => [...skillKeys.all, 'versions', packageId] as const,
  market: (params: { search: string; category: string }) =>
    [...skillKeys.all, 'market', params] as const,
  /** ：按工作区 working_dir 扫描目录自带 Skill */
  workspaceScan: (workspaceRoot: string) =>
    [...skillKeys.all, 'workspace-scan', workspaceRoot] as const,
}

/** Agent 携带集 query key；与 `useAgentSkillsQuery` / list 合流共用，避免双拉。 */
export const agentSkillKeys = {
  all: ['agent-skills'] as const,
  list: (agentId: string) => [...agentSkillKeys.all, 'list', agentId] as const,
}

const LOCAL_RUNTIME_SKILL_SOURCES = new Set(['platform', 'app', 'device'])
const LOCAL_PACKAGE_SKILL_SLUG_RE = /^[\w][\w.\-@]*$/
const OFFICIAL_PLUGIN_APP_IDS = new Set(['cowart'])
const MIN_EXPECTED_BUNDLED_RUNTIME_SKILLS = 20

function isPersonalPluginRuntimeSkill(skill: SkillIndexEntry): boolean {
  return normalizeSkillSource(skill.source) === 'user'
    && typeof skill.meta?.personal_plugin_id === 'string'
}

function isOfficialPluginAppSkill(skill: SkillIndexEntry): boolean {
  if (normalizeSkillSource(skill.source) !== 'app') return false
  if (typeof skill.meta?.official_plugin_release === 'object') return true
  if (typeof skill.meta?.prepared_runtime === 'object') return true
  if (typeof (skill as { official_plugin_release?: unknown }).official_plugin_release === 'object') return true
  if (typeof (skill as { prepared_runtime?: unknown }).prepared_runtime === 'object') return true
  const appId = typeof skill.app_id === 'string' ? skill.app_id : null
  if (appId && OFFICIAL_PLUGIN_APP_IDS.has(appId)) return true
  const key = skill.skill_key || ''
  return key.startsWith('app:cowart/')
}

function isLocalRuntimeCatalogSkill(skill: SkillIndexEntry): boolean {
  return LOCAL_RUNTIME_SKILL_SOURCES.has(normalizeSkillSource(skill.source))
    || isPersonalPluginRuntimeSkill(skill)
}

function isBundledRuntimeCatalogSkill(skill: SkillIndexEntry): boolean {
  const source = normalizeSkillSource(skill.source)
  if (source === 'platform') return true
  return source === 'app'
    && skill.distribution !== 'marketplace'
    && !isOfficialPluginAppSkill(skill)
}

function isBackendPackageSkill(skill?: SkillIndexEntry | null): skill is SkillIndexEntry {
  return Boolean(
    skill?.package_id
      && normalizeSkillSource(skill.source) === 'user',
  )
}

function getSkillKey(skill: SkillIndexEntry): string {
  return skill.skill_key || skill.skill_id
}

function getLocalPackageSkillInstallSlug(skill: SkillIndexEntry): string {
  const key = getSkillKey(skill)
  const slug = key.includes(':') ? key.split(':').slice(1).join(':') : key
  if (!LOCAL_PACKAGE_SKILL_SLUG_RE.test(slug) || slug.includes('..')) {
    throw new Error(`Backend package skill key cannot be materialized locally: ${key}`)
  }
  return slug
}

/** 把用户总闸盖到本地 runtime catalog（后端 visible 不含 device 行）。缺键=开。 */
function applyUserGatesToLocalRuntimeSkills(
  skills: SkillIndexEntry[],
  userGates: Record<string, boolean> | undefined,
): SkillIndexEntry[] {
  return skills.map((skill) => {
    if (!isLocalRuntimeCatalogSkill(skill)) return skill
    const key = getSkillKey(skill)
    if (!key) return skill
    return {
      ...skill,
      enabled: userGates?.[key] !== false,
      acquired: Object.prototype.hasOwnProperty.call(userGates ?? {}, key),
    }
  })
}

/** 后端可见条目同样补上用户级“已获取”状态；Agent 携带态仍由 installed 单独表达。 */
function applyUserAcquisitionToBackendSkills(
  skills: SkillIndexEntry[],
  userGates: Record<string, boolean> | undefined,
): SkillIndexEntry[] {
  return skills.map((skill) => {
    const key = getSkillKey(skill)
    if (!key) return skill
    return {
      ...skill,
      acquired: Object.prototype.hasOwnProperty.call(userGates ?? {}, key),
    }
  })
}

/**
 * 本地 runtime catalog 的 Agent 携带态回填。
 *
 * 优先级：
 * 1. `GET /agents/{id}/skills` 携带集（真源；覆盖 device 等 visible 无行的本地技能）
 * 2. 有效携带快照缺 device 行：仅小Tin 默认可用；其他分身须从「技能-我的」显式分配
 * 3. `/skills/visible.skills[]` 瘦条目（请求失败或 platform/app 等来源的兜底）
 *
 * 只回填斜杠/启用判定所需的 `installed` + `agent_enabled`。
 */
function applyAgentCarryStateToLocalRuntimeSkills(
  localSkills: SkillIndexEntry[],
  backendSkills: SkillIndexEntry[],
  agentLinks: ReadonlyArray<Pick<AgentSkillLinkItem, 'skill_canonical_key' | 'agent_enabled'>> | null,
  isDefaultAgent: boolean,
): SkillIndexEntry[] {
  const carryByKey = new Map<string, SkillIndexEntry>()
  for (const skill of backendSkills) {
    if (!isLocalRuntimeCatalogSkill(skill)) continue
    const key = getSkillKey(skill)
    if (!key) continue
    carryByKey.set(key, skill)
  }
  const linkByKey = new Map<string, Pick<AgentSkillLinkItem, 'skill_canonical_key' | 'agent_enabled'>>()
  for (const link of agentLinks ?? []) {
    const key = link.skill_canonical_key
    if (!key) continue
    linkByKey.set(key, link)
  }
  return localSkills.map((skill) => {
    if (!isLocalRuntimeCatalogSkill(skill)) return skill
    const key = getSkillKey(skill)
    if (!key) return skill
    const link = linkByKey.get(key)
    if (link) {
      // 只用 Agent 子开关；`enabled` 是 user∧agent，不能当子开关回退。
      return {
        ...skill,
        installed: true,
        agent_enabled: link.agent_enabled === true,
      }
    }
    const locallyDiscoveredDevice = normalizeSkillSource(skill.source) === 'device'
      || key.startsWith('device:')
    if (agentLinks !== null && locallyDiscoveredDevice) {
      return {
        ...skill,
        agent_enabled: isDefaultAgent,
      }
    }
    const backend = carryByKey.get(key)
    return {
      ...skill,
      installed: backend?.installed === true,
      agent_enabled: backend?.agent_enabled === true,
    }
  })
}

async function fetchLocalRuntimeSkills(
  spaceId: string,
  organizationId: string | null,
): Promise<SkillIndexEntry[]> {
  if (!organizationId) return []
  const api = window.tabtin?.skill?.list
  if (!api) {
    log.warn('local skill:list IPC unavailable; built-in catalog cannot be loaded')
    throw new LocalRuntimeSkillIpcUnavailableError('local skill:list IPC unavailable')
  }
  try {
    const result = await api({ spaceId, organizationId })
    return (result?.skills ?? []).filter(isLocalRuntimeCatalogSkill)
  } catch (err) {
    log.warn('local skill:list failed; built-in catalog not ready:', err)
    throw new LocalRuntimeSkillCatalogError('local skill:list failed', { cause: err })
  }
}

// ---------------------------------------------------------------------------
// Shared fetch helper
// ---------------------------------------------------------------------------

function getAuthHeaders(): HeadersInit {
  const token = useAuthStore.getState().accessToken
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** ：本地 skill IPC 必填真实 userId，禁止落到 `_unscoped`。 */
function requireCurrentUserId(): string {
  const userId = useAuthStore.getState().user?.id
  if (userId === undefined || userId === null || userId === '') {
    throw new Error('Cannot resolve userId: not authenticated')
  }
  return String(userId)
}

async function skillApiRequest<T = any>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const resp = await electronFetch(joinApiPath(API_CONFIG.baseURL, `${url}`), {
    headers: getAuthHeaders(),
    ...options,
  })
  if (!resp.ok) {
    let errorCode: string | undefined
    let errorMessage: string | undefined
    let errorData: unknown
    try {
      const body = await resp.json()
      errorCode = body?.error?.code ?? body?.code
      errorMessage = body?.error?.message ?? body?.message
      errorData = body?.error?.data ?? body?.data
    } catch {
      // 非 JSON
    }
    const err = new Error(
      errorMessage || `Skills API error: ${resp.status} ${resp.statusText}`,
    ) as Error & { status?: number; code?: string; data?: unknown }
    err.status = resp.status
    err.code = errorCode
    err.data = errorData
    throw err
  }
  const json = await resp.json()
  return json?.data ?? json
}

/** 静默创建（不 invalidate）——共享流程中途刷新会把半成品刷进列表。 */
export async function createSkillSilent(payload: SkillCreatePayload): Promise<SkillIndexEntry> {
  return skillApiRequest<SkillIndexEntry>(API_ENDPOINTS.SKILLS.CREATE, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** 静默发布（不 invalidate）。 */
export async function publishSkillSilent(
  params: { skillId: string } & SkillPublishPayload,
): Promise<SkillIndexEntry> {
  return skillApiRequest<SkillIndexEntry>(
    API_ENDPOINTS.SKILLS.PUBLISH(params.skillId),
    {
      method: 'POST',
      body: JSON.stringify({
        organization_id: params.organization_id,
        version_label: params.version_label,
        visibility: params.visibility,
        change_note: params.change_note,
        files: params.files,
        ...(params.quick_use !== undefined ? { quick_use: params.quick_use } : {}),
      }),
    },
  )
}

/** 静默删除（不 invalidate）。 */
export async function deleteSkillSilent(params: {
  skillId: string
}): Promise<{ skill_id: string; deleted: boolean }> {
  return skillApiRequest<{ skill_id: string; deleted: boolean }>(
    API_ENDPOINTS.SKILLS.DELETE_SKILL(params.skillId),
    { method: 'DELETE' },
  )
}

/** 静默改可见性（不 invalidate）。 */
export async function updateSkillVisibilitySilent(params: {
  skillId: string
  visibility: 'private' | 'organization' | 'public'
  organizationId?: string | null
}): Promise<SkillIndexEntry> {
  return skillApiRequest<SkillIndexEntry>(
    API_ENDPOINTS.SKILLS.UPDATE_VISIBILITY(params.skillId),
    {
      method: 'PATCH',
      body: JSON.stringify({
        visibility: params.visibility,
        organization_id: params.organizationId ?? undefined,
      }),
    },
  )
}

/** 共享流程结束后统一刷列表（成功 / 失败清理后都要调）。 */
export function invalidateSkillSpaceQueries(
  queryClient: { invalidateQueries: (opts: { queryKey: readonly unknown[] }) => unknown },
  organizationId: string | null | undefined,
): void {
  if (!organizationId) return
  void queryClient.invalidateQueries({ queryKey: skillKeys.list(organizationId) })
  void queryClient.invalidateQueries({ queryKey: skillKeys.configs(organizationId) })
  void queryClient.invalidateQueries({ queryKey: skillKeys.visible(organizationId) })
}

interface PackageRegistryFile {
  path: string
  sha256: string
  size: number
  download_url: string
  content_type?: string | null
}

interface PackageVersionFilesResponse {
  version_seq: number
  version_label?: string | null
  bundle_sha256?: string | null
  files: PackageRegistryFile[]
}

async function fetchPackageVersionFiles(
  packageId: string,
  versionSeq: number,
): Promise<PackageVersionFilesResponse> {
  return skillApiRequest<PackageVersionFilesResponse>(
    `/services/package-registry/packages/${packageId}/versions/${versionSeq}/files`,
  )
}

/**
 * 从当前 space 列表推导 organizationId（安装落盘目录必须与 registry 扫描/渲染用的
 * (organizationId, spaceId) 一致）。找不到返回 undefined——落盘路径由宿主回退当前活跃
 * organization（app 物化路径要求非空，缺失时会显式报错，不静默落到 `_unscoped`）。
 */
function resolveOrganizationIdForSpace(spaceId: string): string | undefined {
  return useSpaceStore.getState().spaces.find(s => s.id === spaceId)?.organization_id ?? undefined
}

function requireOrganizationIdForSpace(spaceId: string, action: string): string {
  const organizationId = resolveOrganizationIdForSpace(spaceId)
  if (!organizationId) {
    throw new Error(`Cannot ${action}: organizationId not resolved for space`)
  }
  return organizationId
}

function invalidateSkillQueriesForSpace(
  queryClient: QueryClient,
  spaceId: string,
  scopes: Array<'list' | 'configs' | 'visible'>,
): void {
  const organizationId = resolveOrganizationIdForSpace(spaceId)
  if (!organizationId) return
  for (const scope of scopes) {
    void queryClient.invalidateQueries({ queryKey: skillKeys[scope](organizationId) })
  }
}

/**
 * marketplace 分发的 app skill 本地物化：把 bundled 源拷进当前 Space 的 skills 目录，
 * 让 `LocalSkillRegistry` 扫得到、Agent `<skills>` 可见（ app 子案）。
 * appId/slug 从 `app:<appId>/<slug>` canonical key 解析，slug 走安全字符白名单防穿越。
 */
function getAppSkillCoords(skill: SkillIndexEntry): { appId: string; slug: string } | null {
  if (normalizeSkillSource(skill.source) !== 'app') return null
  const key = getSkillKey(skill)
  const afterColon = key.includes(':') ? key.split(':').slice(1).join(':') : key
  let appId = typeof skill.app_id === 'string' && skill.app_id ? skill.app_id : ''
  let slug = ''
  if (afterColon.includes('/')) {
    const [keyAppId, ...rest] = afterColon.split('/')
    if (!appId) appId = keyAppId
    slug = rest.join('/')
  } else {
    slug = skill.skill_id || afterColon
  }
  if (!slug && skill.skill_id) slug = skill.skill_id
  if (!appId || !slug) return null
  if (!LOCAL_PACKAGE_SKILL_SLUG_RE.test(appId) || appId.includes('..')) return null
  if (!LOCAL_PACKAGE_SKILL_SLUG_RE.test(slug) || slug.includes('..')) return null
  return { appId, slug }
}

async function materializeAppSkillLocally(params: {
  skill: SkillIndexEntry
  spaceId: string
}): Promise<void> {
  const coords = getAppSkillCoords(params.skill)
  if (!coords) return
  const organizationId = resolveOrganizationIdForSpace(params.spaceId)
  if (!organizationId) {
    throw new Error('Cannot materialize app skill locally: organizationId not resolved for space')
  }
  const api = window.tabtin?.skill?.materializeApp
  if (!api) {
    throw new Error('Local skill materialize IPC is unavailable')
  }
  await api({
    spaceId: params.spaceId,
    organizationId,
    userId: requireCurrentUserId(),
    appId: coords.appId,
    slug: coords.slug,
  })
}

async function installBackendSkillLocally(params: {
  skill: SkillIndexEntry
  spaceId: string
  organizationId?: string
  versionSeq: number
  /** 升级场景强制从 Registry 覆盖；启用场景若本地已有真正文则跳过，避免模板包盖掉导入内容。 */
  force?: boolean
}): Promise<void> {
  const packageId = params.skill.package_id
  if (!packageId) return

  // 导入后 Electron 已用 normalized_files 物化真正文；若 Registry 仍是旧后端留下的
  // 模板首发，启用时装包会盖掉本地。本地已有非模板正文时跳过（升级 force=true 除外）。
  if (!params.force) {
    const readApi = window.tabtin?.skill?.readContent
    if (readApi) {
      try {
        const local = await readApi({
          skillKey: getSkillKey(params.skill),
          spaceId: params.spaceId,
          organizationId: resolveOrganizationIdForSpace(params.spaceId),
          userId: requireCurrentUserId(),
        })
        // ：本地已有 SKILL.md（含骨架）即跳过 Registry，避免 OSS 404 阻断启用
        if (localSkillMdExists(local?.content)) {
          log.info('skip registry install: local SKILL.md already exists', {
            skillKey: getSkillKey(params.skill),
            spaceId: params.spaceId,
            versionSeq: params.versionSeq,
          })
          return
        }
      } catch (err) {
        log.warn('failed to probe local skill content before install; continuing with registry', err)
      }
    }
  }

  const api = window.tabtin?.skill?.install
  if (!api) {
    throw new Error('Local skill install IPC is unavailable')
  }
  const organizationId = params.organizationId
    ?? resolveOrganizationIdForSpace(params.spaceId)
  if (!organizationId) {
    throw new Error('Cannot install backend skill locally: organizationId not resolved for space')
  }
  const bundle = await fetchPackageVersionFiles(packageId, params.versionSeq)
  if (!bundle.files?.length) {
    throw new Error('Package Registry returned no files for skill install')
  }
  await api({
    skillKey: getLocalPackageSkillInstallSlug(params.skill),
    spaceId: params.spaceId,
    userId: requireCurrentUserId(),
    // 显式传 organizationId，落盘目录与 registry 扫描/渲染一致，消除 `_unscoped` 漂移。
    organizationId,
    files: bundle.files.map(file => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
      download_url: file.download_url,
      content_type: file.content_type ?? '',
    })),
    meta: {
      source: normalizeSkillSource(params.skill.source),
      slug: getLocalPackageSkillInstallSlug(params.skill),
      canonicalKey: getSkillKey(params.skill),
      version: bundle.version_label || params.skill.version || String(bundle.version_seq),
      installedAt: new Date().toISOString(),
      packageId,
      versionSeq: bundle.version_seq,
      bundleSha256: bundle.bundle_sha256 ?? undefined,
    },
  })
}

/**
 * 分享专用恢复：只允许从不可变的云端发布版本恢复真实文件，绝不生成骨架。
 * 调用方恢复后应重新解析并确认 SKILL.md 已落盘，再创建组织快照。
 */
export async function restorePublishedSkillForShare(params: {
  skill: SkillIndexEntry
  spaceId: string
  organizationId: string
  versionSeq: number
}): Promise<void> {
  if (!isBackendPackageSkill(params.skill)) {
    throw new Error('该 Skill 没有可恢复的云端发布版本')
  }
  await installBackendSkillLocally({
    ...params,
    force: true,
  })
}

/**
 * ：添加/启用后保证本机有可调用的 SKILL.md。
 * - 已有正文 → 跳过
 * - user + package_id → Registry 装包（与 enable 同路径）
 * - app → materializeApp
 * - 其余 user → 写骨架兜底（避免「云端已开、本机无文件」）
 */
export async function ensureSkillMaterializedLocally(params: {
  skill: SkillIndexEntry
  spaceId: string
  /** 分配对话框等无 space→org 映射时可由调用方直传 */
  organizationId?: string
  /**
   * 优先使用 enable/attach 返回的已安装版本；缺省再回落 skill 元数据。
   * （enable 权威是 `installed_version_seq`，勿先拿 latest_approved 盖掉。）
   */
  versionSeq?: number | null
}): Promise<'exists' | 'installed' | 'app' | 'skeleton'> {
  const organizationId = params.organizationId
    ?? resolveOrganizationIdForSpace(params.spaceId)
  if (!organizationId) {
    throw new Error('Cannot materialize skill locally: organizationId not resolved for space')
  }
  const skillKey = getSkillKey(params.skill)
  if (!skillKey) {
    throw new Error('Cannot materialize skill locally: missing skill_key')
  }

  const readApi = window.tabtin?.skill?.readContent
  if (readApi) {
    try {
      const local = await readApi({
        skillKey,
        spaceId: params.spaceId,
        organizationId,
        userId: requireCurrentUserId(),
      })
      if (localSkillMdExists(local?.content)) {
        return 'exists'
      }
    } catch (err) {
      log.warn('failed to probe local skill before materialize; continuing', err)
    }
  }

  const source = normalizeSkillSource(params.skill.source)

  if (isBackendPackageSkill(params.skill)) {
    const versionSeq = params.versionSeq
      ?? params.skill.installed_version_seq
      ?? params.skill.latest_approved_version_seq
      ?? params.skill.latest_version_seq
    if (versionSeq) {
      await installBackendSkillLocally({
        skill: params.skill,
        spaceId: params.spaceId,
        versionSeq,
      })
      return 'installed'
    }
    log.warn('user package skill has no version_seq; falling back to skeleton', { skillKey })
  } else if (source === 'app') {
    await materializeAppSkillLocally({
      skill: params.skill,
      spaceId: params.spaceId,
    })
    return 'app'
  }

  if (source !== 'user') {
    throw new Error(`Cannot materialize skill locally for source=${source}: ${skillKey}`)
  }

  const slug = skillKey.includes(':') ? skillKey.split(':').slice(1).join(':') : skillKey
  const name = (params.skill.name || slug).trim() || slug
  const description = (params.skill.description || name).trim() || name
  const content = generateSkillSkeleton(
    name,
    description,
    params.skill.category,
    slug,
  )
  await writeSkillContent({
    spaceId: params.spaceId,
    organizationId,
    skillKey,
    content,
  })
  return 'skeleton'
}

/** platform / 非 marketplace app：无 enablement 行 = 宽松默认开启。device 已改为 opt-in。 */
function isSoftDefaultOnSkill(skill: SkillIndexEntry | undefined): boolean {
  if (!skill) return false
  const source = normalizeSkillSource(skill.source)
  if (source === 'platform') return true
  return source === 'app' && skill.distribution !== 'marketplace'
}

async function disableSkillWithSoftDefaultFallback(params: {
  canonicalKey: string
  spaceId: string
  skill?: SkillIndexEntry
  removeLocal?: boolean
  forgetAcquisition?: boolean
}): Promise<{ skill_canonical_key: string; enabled: false; found: boolean }> {
  const organizationId = resolveOrganizationIdForSpace(params.spaceId)
  if (!organizationId) {
    throw new Error('Cannot disable skill: organizationId not resolved for space')
  }
  const result = await skillApiRequest<{ skill_canonical_key: string; enabled: false; found: boolean }>(
    API_ENDPOINTS.SKILLS.DISABLE(params.canonicalKey),
    {
      method: 'POST',
      body: JSON.stringify({
        organization_id: organizationId,
        remove: !!params.removeLocal,
        forget_acquisition: !!params.forgetAcquisition,
      }),
    },
  )
  // 旧后端 disable 只 UPDATE：无行 → found=false。对宽松默认开启的来源，先 enable 建行再 disable。
  if (!params.removeLocal && !result?.found && isSoftDefaultOnSkill(params.skill)) {
    const body: Record<string, unknown> = { organization_id: organizationId }
    if (normalizeSkillSource(params.skill!.source) === 'device' && params.skill?.agents) {
      body.agents = params.skill.agents
    }
    await skillApiRequest(API_ENDPOINTS.SKILLS.ENABLE(params.canonicalKey), {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return skillApiRequest<{ skill_canonical_key: string; enabled: false; found: boolean }>(
      API_ENDPOINTS.SKILLS.DISABLE(params.canonicalKey),
      {
        method: 'POST',
        body: JSON.stringify({ organization_id: organizationId, remove: false }),
      },
    )
  }
  return result
}

async function uninstallBackendSkillLocally(params: {
  skill: SkillIndexEntry
  spaceId: string
}): Promise<void> {
  if (!isBackendPackageSkill(params.skill)) return
  const api = window.tabtin?.skill?.uninstall
  if (!api) {
    throw new Error('Local skill uninstall IPC is unavailable')
  }
  await api({
    skillKey: getLocalPackageSkillInstallSlug(params.skill),
    spaceId: params.spaceId,
    userId: requireCurrentUserId(),
    organizationId: resolveOrganizationIdForSpace(params.spaceId) ?? undefined,
  })
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Marketplace catalog（外部可发现的 Skill 列表）
// ---------------------------------------------------------------------------

/** Skill marketplace 列表项（含可选的 installed 标记） */
export interface MarketSkillItem extends SkillIndexEntry {
  installed?: boolean
}

/**
 * Skill marketplace 列表 query。原本散落在 SkillMarketplace 组件里直 fetch，
 * 收敛到 hooks/queries 层避免组件内拼 API URL（contract Wave 1-B）。
 */
export function useSkillMarketQuery(params: { search: string; category: string }) {
  return useQuery({
    queryKey: skillKeys.market(params),
    queryFn: async (): Promise<MarketSkillItem[]> => {
      const url = API_ENDPOINTS.SKILLS.MARKET({
        q: params.search || undefined,
        category: params.category === 'all' ? undefined : params.category,
      })
      const data = await skillApiRequest<{ skills?: MarketSkillItem[] }>(url)
      // Skill 市场只展示可安装商品：marketplace pack + 公开 user skill。
      // 内置 platform / 随 App 走的 builtin Operator、本机插件 skill 都不进货架。
      return (data?.skills ?? []).filter((skill) => {
        const source = normalizeSkillSource(skill.source)
        if (source === 'device' || source === 'platform') return false
        if (source === 'app' && skill.distribution !== 'marketplace') return false
        if (isOfficialPluginAppSkill(skill)) return false
        if (isPersonalPluginRuntimeSkill(skill)) return false
        return true
      })
    },
    staleTime: 60_000,
  })
}

/**
 * 技能库目录主入口：按组织列出可见 Skill。
 *
 * Built-in platform/app/device catalog 来自本地 runtime registry；Django
 * `/skills/visible` 只补 user / marketplace 等后端权威数据 + 用户总闸。
 *
 * ：目录本身与 Agent 无关——HTTP 默认只传 organization_id，不因
 * `selectedAgent` 缺失而禁用请求。显式传入 `agentId` 时（斜杠 / 需要携带态的
 * 调用方）仍走 ：用 `GET /agents/{id}/skills` 回填本地 catalog 的
 * `installed` / `agent_enabled`。
 *
 *  / ：当前 Space `working_dir` 扫到的工作区目录 Skill 并入本列表；
 * 工作区级发现范围归工作区；显式 `agentId` 时 `agent_enabled` 读携带关系，
 * 否则目录与 Agent 无关。能力市场页签支持 liveCatalog 轮询与可见性约束。
 * Composer `/` 与其它消费者只读本 hook，不再二次扫工作区拼接。
 * `spaceId` 仅用于本地 skill:list IPC / 工作区扫描。
 */
export type SkillsListQueryOptions = {
  /**
   * 能力市场：缩短新鲜窗口；页签重新可见时必拉一次。
   * 轮询另受 `catalogActive` 约束，与连接器侧对称。
   */
  liveCatalog?: boolean
  /**
   * 市场「技能」页签是否可见。为 false 时停止轮询。
   * 未传时视为可见（库面板 / 非市场入口）。
   */
  catalogActive?: boolean
  /**
   * 是否发现当前 Workspace 目录中的 Skill。
   * Skill 市场默认货架关闭；Composer 等真实使用入口保持默认开启。
   */
  includeWorkspaceSkills?: boolean
}

export function useSkillsListQuery(
  spaceId: string | null,
  agentId?: string | null,
  options?: SkillsListQueryOptions,
) {
  const queryClient = useQueryClient()
  const liveCatalog = options?.liveCatalog === true
  const catalogActive = options?.catalogActive !== false
  const includeWorkspaceSkills = options?.includeWorkspaceSkills !== false
  const organizationIdFromSpace = useSpaceStore(state =>
    spaceId ? state.spaces.find(s => s.id === spaceId)?.organization_id ?? null : null,
  )
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const pendingOrganizationId = useOrganizationStore(state => state.pendingOrganizationId)
  const organizationId = resolveOrganizationId({
    pendingOrganizationId,
    selectedOrganizationId,
    contextOrganizationId: organizationIdFromSpace,
  })
  // ：不回退 selectedAgent——技能库/Agent 设置池只锚组织；
  // ：斜杠等调用方显式传 sessionAgentId 时才拉携带集。
  const resolvedAgentId = agentId ?? null
  const selectedAgent = useSpaceStore(state => state.selectedAgent)
  const agentCache = useSpaceStore(state => state.agentCache)
  const isDefaultAgent = Boolean(
    (selectedAgent?.id === resolvedAgentId ? selectedAgent : null)?.is_default
    ?? (resolvedAgentId ? agentCache[resolvedAgentId]?.is_default : undefined),
  )
  const {
    spaceId: workspaceSpaceId,
    spaceName: workspaceSpaceName,
    workingDir: workspaceWorkingDir,
    skills: workspaceScanEntries,
  } = useSpaceWorkspaceSkillScan(spaceId, includeWorkspaceSkills)
  const workspaceAgentLinksQuery = useQuery({
    queryKey: ['agent-skills', 'list', resolvedAgentId ?? ''] as const,
    queryFn: async (): Promise<AgentSkillLinkItem[]> => {
      const data = await skillApiRequest<{ skills: AgentSkillLinkItem[]; total: number }>(
        API_ENDPOINTS.AGENT.SKILLS(resolvedAgentId!),
      )
      return data?.skills ?? []
    },
    enabled: !!resolvedAgentId,
    staleTime: 30_000,
  })

  const listQuery = useQuery({
    queryKey: resolvedAgentId
      ? [...skillKeys.list(organizationId ?? '', resolvedAgentId), isDefaultAgent] as const
      : skillKeys.list(organizationId ?? ''),
    queryFn: async () => {
      const fetches: Array<Promise<unknown>> = [
        skillApiRequest<{
          skills: SkillIndexEntry[]
          /** canonical_key → 用户总闸；缺键视为开（opt-out） */
          user_gates?: Record<string, boolean>
        }>(
          API_ENDPOINTS.SKILLS.VISIBLE(organizationId!, resolvedAgentId),
        ),
        fetchLocalRuntimeSkills(spaceId ?? '', organizationId),
      ]
      if (resolvedAgentId) {
        // ：经 agentSkillKeys 拉携带集（与 Agent 技能面板共享缓存）。
        fetches.push(
          queryClient.fetchQuery({
            queryKey: agentSkillKeys.list(resolvedAgentId),
            queryFn: async (): Promise<AgentSkillLinkItem[]> => {
              const data = await skillApiRequest<{ skills: AgentSkillLinkItem[]; total?: number }>(
                API_ENDPOINTS.AGENT.SKILLS(resolvedAgentId),
              )
              return data?.skills ?? []
            },
            staleTime: 30_000,
          }),
        )
      }
      const [backendResult, localResult, agentLinksResult] = await Promise.allSettled(fetches)
      const localRuntimeSkills = localResult.status === 'fulfilled'
        ? localResult.value as SkillIndexEntry[]
        : []
      if (backendResult.status === 'rejected') {
        // 禁止静默回落本机 catalog：否则「组织精选」等依赖后端 user 行的货架会空，
        // 且无 toast / 诊断包几乎看不到失败（api-proxy 只记网络层错误）。
        log.warn('visible fetch failed', backendResult.reason)
        throw backendResult.reason
      }
      if (localResult.status === 'rejected') {
        throw localResult.reason
      }
      if (agentLinksResult && agentLinksResult.status === 'rejected') {
        log.warn(
          'agent skills carry list failed; local catalog agent_enabled may miss device rows',
          agentLinksResult.reason,
        )
      }
      const agentLinks = (
        agentLinksResult && agentLinksResult.status === 'fulfilled'
          ? agentLinksResult.value
          : null
      ) as AgentSkillLinkItem[] | null
      const payload = (backendResult.value ?? {}) as {
        skills?: SkillIndexEntry[]
        user_gates?: Record<string, boolean>
      }
      // ：不依赖 Agent 携带态对账。本地 IPC 完全空时重试 warmup；
      // 仅有 Personal Plugin / 薄 bundled 时放行并告警。
      // 260805：后端行叠加用户获取态（acquired）
      const allBackendSkills = applyUserAcquisitionToBackendSkills(
        payload.skills ?? [],
        payload.user_gates,
      )
      const orgFeaturedCount = allBackendSkills.filter(
        (skill) =>
          normalizeSkillSource(skill.source) === 'user'
          && skill.visibility === 'organization',
      ).length
      if (orgFeaturedCount > 0) {
        log.info('visible catalog loaded', {
          organizationId,
          total: allBackendSkills.length,
          orgFeatured: orgFeaturedCount,
        })
      }
      const localBundledCatalogCount = localRuntimeSkills.filter(isBundledRuntimeCatalogSkill).length
      if (localRuntimeSkills.length === 0) {
        throw new LocalRuntimeSkillCatalogError(
          'local skill:list returned empty catalog',
        )
      }
      if (localBundledCatalogCount < MIN_EXPECTED_BUNDLED_RUNTIME_SKILLS) {
        log.warn(
          `local skill:list bundled catalog thin (${localBundledCatalogCount}); continuing org catalog`,
        )
      }
      const localWithUserGates = applyUserGatesToLocalRuntimeSkills(
        localRuntimeSkills,
        payload.user_gates,
      )
      const localCatalog = resolvedAgentId
        ? applyAgentCarryStateToLocalRuntimeSkills(
          localWithUserGates,
          allBackendSkills,
          agentLinks,
          isDefaultAgent,
        )
        : localWithUserGates
      const localKeys = new Set(
        localCatalog.map(getSkillKey).filter((key): key is string => Boolean(key)),
      )
      // 本地已有的 catalog 行勿被后端瘦条目覆盖；user / marketplace 等后端权威行保留。
      // marketplace 可安装货架即使未携带也要保留，供能力市场「推荐」展示。
      // 注意：获取后会 materialize 到本地（同 skill_key、source=app）。若仍按
      //「本地已有 → 丢后端」处理，会丢掉 distribution=marketplace，推荐货架瞬间空掉。
      const backendOwnedSkills = allBackendSkills.filter((skill) => {
        const key = getSkillKey(skill)
        const isMarketplaceApp = normalizeSkillSource(skill.source) === 'app'
          && skill.distribution === 'marketplace'
        if (
          key
          && localKeys.has(key)
          && isLocalRuntimeCatalogSkill(skill)
          && !isMarketplaceApp
        ) {
          return false
        }
        if (!isLocalRuntimeCatalogSkill(skill)) return true
        // 市场包：组织目录可浏览，不依赖当前 Agent 是否携带；本地物化后以后端行为准
        return isMarketplaceApp
      })
      // 市场包放在后面：同 key 时以后端 marketplace 行覆盖本地物化行，保留货架身份
      return mergeSkillCatalogEntries(
        [...localCatalog, ...backendOwnedSkills].filter(skill => !isTemporarilyHiddenSkill(skill)),
      )
    },
    enabled: !!organizationId,
    retry: (failureCount, error) => {
      if (isLocalRuntimeSkillCatalogError(error)) return true
      return isLocalRuntimeSkillIpcUnavailableError(error) && failureCount < 3
    },
    retryDelay: attemptIndex => Math.min(500 * (attemptIndex + 1), 2_000),
    // 新鲜缓存直接用于首屏；过期时仍由 React Query 保留旧数据并在后台刷新。
    staleTime: liveCatalog ? 30_000 : 60_000,
    gcTime: 30 * 60_000,
    refetchOnMount: true,
    refetchInterval: liveCatalog && catalogActive ? 15_000 : false,
    // 轮询期间保留上一帧列表，避免骨架闪一下。
    placeholderData: liveCatalog ? keepPreviousData : undefined,
  })

  const data = useMemo(() => {
    const base = listQuery.data
    if (!base) return base
    if (!workspaceWorkingDir || workspaceScanEntries.length === 0 || !workspaceSpaceId) {
      return base
    }
    const enabledWorkspaceKeys = new Set(
      (workspaceAgentLinksQuery.data ?? [])
        .filter(link => link.enabled)
        .map(link => link.skill_canonical_key),
    )
    const workspaceSkills = workspaceScanEntries.map((entry) =>
      mapWorkspaceScanToSkillIndexEntry(entry, {
        spaceId: workspaceSpaceId,
        spaceName: workspaceSpaceName || workspaceSpaceId,
        agentEnabled: enabledWorkspaceKeys.has(entry.key),
      }),
    )
    return mergeSkillCatalogEntries(
      [...base, ...workspaceSkills].filter(skill => !isTemporarilyHiddenSkill(skill)),
    )
  }, [
    listQuery.data,
    workspaceWorkingDir,
    workspaceSpaceId,
    workspaceSpaceName,
    workspaceScanEntries,
    workspaceAgentLinksQuery.data,
  ])

  return {
    ...listQuery,
    data,
  }
}

export function useSkillConfigsQuery(spaceId: string | null, agentId?: string | null) {
  const organizationIdFromSpace = useSpaceStore(state =>
    spaceId ? state.spaces.find(s => s.id === spaceId)?.organization_id ?? null : null,
  )
  const selectedOrganizationId = useOrganizationStore(
    state => state.selectedOrganization?.id ?? null,
  )
  const pendingOrganizationId = useOrganizationStore(state => state.pendingOrganizationId)
  const organizationId = resolveOrganizationId({
    pendingOrganizationId,
    selectedOrganizationId,
    contextOrganizationId: organizationIdFromSpace,
  })
  const selectedAgentId = useSpaceStore(state => state.selectedAgent?.id ?? null)
  const resolvedAgentId = agentId ?? selectedAgentId

  return useQuery({
    queryKey: skillKeys.configs(organizationId ?? '', resolvedAgentId),
    queryFn: async () => {
      const data = await skillApiRequest<{ configs: Record<string, SkillConfig> }>(
        API_ENDPOINTS.SKILLS.CONFIG_LIST(organizationId!, resolvedAgentId),
      )
      return data?.configs ?? {}
    },
    enabled: !!organizationId && !!resolvedAgentId,
    staleTime: 60_000,
  })
}

/**
 * 读取 SKILL.md 全文。组织精选优先读云端发布快照；其它来源优先走主进程
 * LocalSkillRegistry，当前 Space 上下文存在时也可回退读取本地草稿文件。
 */
export function useSkillContentQuery(
  skillKey: string | null,
  context?: {
    spaceId?: string | null
    organizationId?: string | null
    sourceDocPath?: string | null
    publishedSnapshotSkillId?: string | null
  },
) {
  return useQuery({
    queryKey: [
      ...skillKeys.content(skillKey ?? ''),
      context?.spaceId ?? '',
      context?.organizationId ?? '',
      context?.sourceDocPath ?? '',
      context?.publishedSnapshotSkillId ?? '',
    ] as const,
    queryFn: async (): Promise<string | null> => {
      if (!skillKey) return null
      if (context?.publishedSnapshotSkillId && context.organizationId) {
        const query = new URLSearchParams({
          organization_id: context.organizationId,
          skill_id: context.publishedSnapshotSkillId,
        })
        const packageDetail = await skillApiRequest<{ doc_content?: string | null }>(
          `/skills/${encodeURIComponent(skillKey)}/package?${query.toString()}`,
        )
        if (packageDetail?.doc_content != null) return packageDetail.doc_content
      }
      const api = window.tabtin?.skill?.readContent
      if (!api) {
        throw new Error('IPC skill:read-content not available')
      }
      const result = await api({
        skillKey,
        spaceId: context?.spaceId ?? undefined,
        organizationId: context?.organizationId ?? undefined,
        sourceDocPath: context?.sourceDocPath ?? undefined,
        userId: requireCurrentUserId(),
      })
      return result?.content ?? null
    },
    enabled: !!skillKey,
    staleTime: 5 * 60_000,
  })
}

// ---------------------------------------------------------------------------
// Version history (Package Registry)
// ---------------------------------------------------------------------------

export type { PackageVersion } from '@/skills/types'

export function useSkillVersionsQuery(packageId: string | null) {
  return useQuery({
    queryKey: skillKeys.versions(packageId ?? ''),
    queryFn: async (): Promise<PackageVersion[]> => {
      const data = await skillApiRequest<{ versions: PackageVersion[] }>(
        `/services/package-registry/packages/${packageId}/versions`,
      )
      return data?.versions ?? []
    },
    enabled: !!packageId,
    staleTime: 2 * 60_000,
  })
}

export interface WorkspaceSkillScanResult {
  truncated?: boolean
  skills: Array<{
    key: string
    slug: string
    name: string
    display_name?: string
    description?: string
    emoji?: string
    rel_path?: string
    doc_path?: string
    content_hash?: string
    realpath?: string
  }>
}

/**
 * ：并行扫描多个工作区根目录下的 Skill（技能库「我的」二级 tab）。
 */
export function useWorkspaceSkillsScanQueries(
  roots: Array<{ spaceId: string; workspaceRoot: string }>,
  enabled: boolean,
) {
  return useQueries({
    queries: roots.map(({ spaceId, workspaceRoot }) => ({
      queryKey: skillKeys.workspaceScan(workspaceRoot),
      enabled: enabled && Boolean(workspaceRoot),
      staleTime: 30_000,
      queryFn: async (): Promise<WorkspaceSkillScanResult & { spaceId: string }> => {
        const api = window.tabtin?.skill?.workspaceScan
        if (!api) return { spaceId, skills: [] }
        const result = await api({ workspaceRoot })
        return {
          spaceId,
          truncated: result?.truncated,
          skills: result?.skills ?? [],
        }
      },
    })),
  })
}

/**
 * ：当前 Space 的 working_dir 目录 Skill。
 * 选择器只取原始字段（string），禁止在 selector 里 new 对象——否则 Zustand
 * 每拍都判定变更，下游 useMemo 会 Maximum update depth。
 */
export function useSpaceWorkspaceSkillScan(
  spaceId: string | null | undefined,
  enabled = true,
) {
  const resolvedSpaceId = useSpaceStore((state) => {
    if (!spaceId) return null
    return state.spaces?.find((item) => item.id === spaceId)?.id ?? null
  })
  const spaceName = useSpaceStore((state) => {
    if (!spaceId) return ''
    const space = state.spaces?.find((item) => item.id === spaceId)
    return space?.name?.trim() || space?.id || ''
  })
  const workingDir = useSpaceStore((state) => {
    if (!spaceId) return ''
    return state.spaces?.find((item) => item.id === spaceId)?.working_dir?.trim() || ''
  })
  const query = useQuery({
    queryKey: skillKeys.workspaceScan(workingDir),
    enabled: enabled && Boolean(workingDir),
    staleTime: 30_000,
    queryFn: async (): Promise<WorkspaceSkillScanResult> => {
      const api = window.tabtin?.skill?.workspaceScan
      if (!api || !workingDir) return { skills: EMPTY_WORKSPACE_SCAN_SKILLS }
      const result = await api({ workspaceRoot: workingDir })
      return {
        truncated: result?.truncated,
        skills: result?.skills ?? EMPTY_WORKSPACE_SCAN_SKILLS,
      }
    },
  })
  const spaceMeta = useMemo(
    () => (
      resolvedSpaceId
        ? { spaceId: resolvedSpaceId, spaceName, workingDir }
        : null
    ),
    [resolvedSpaceId, spaceName, workingDir],
  )

  return {
    spaceId: resolvedSpaceId,
    spaceName,
    workingDir,
    spaceMeta,
    skills: enabled ? query.data?.skills ?? EMPTY_WORKSPACE_SCAN_SKILLS : EMPTY_WORKSPACE_SCAN_SKILLS,
    isLoading: enabled && query.isLoading,
    isFetched: query.isFetched,
  }
}

// ---------------------------------------------------------------------------
// Mutations — Wave 1 启用 / 禁用 / 创建
// ---------------------------------------------------------------------------

// 同 space 并发切换协调（ 两轮 review）。
//
// 风险一（第一轮）：onError 若把「整个 configs / 全部 list 查询」快照写回，会抹掉其它并发
//   切换的乐观状态 → 改为只回滚本次 `canonicalKey` 的条目（条目原本不存在则删除）。
// 风险二（第一轮）：onSettled 的 invalidate 会触发 refetch；若早于后发切换落库就返回旧服务端
//   状态，会把仍在 pending 的后发切换乐观态错误回退 → 改为仅当该 space 所有在途切换都 settle
//   后才 invalidate，保证 refetch 反映全部已完成的切换。
// 风险三（第二轮）：同 spaceId + canonicalKey 的相反操作（先 enable 后 disable）并发时，两个
//   请求同时在途、后端按网络完成顺序落库，最终态可能和用户最后一次操作相反；失败时还会把中间
//   态快照写回 → 改为按 `organizationId::canonicalKey` 串行：同一 key 同一时刻只有一个切换在执行
//   （onMutate 也排队），网络写按用户操作顺序发出，后端最终态 == 用户最后一次操作；整条链在途
//   期间都占住 organization 计数，refetch 只在该 key 链排空且 organization 内无其它在途切换时才发生。
const pendingOrganizationToggles = new Map<string, number>()

/** 标记一次切换进入在途；在 key 链首次入队时调用（见 runSerializedToggle）。 */
function beginOrganizationToggle(organizationId: string): void {
  pendingOrganizationToggles.set(
    organizationId,
    (pendingOrganizationToggles.get(organizationId) ?? 0) + 1,
  )
}

/** 标记一次切换结束；返回 true 表示这是该 organization 最后一个在途切换（应当 invalidate）。 */
function endOrganizationToggle(organizationId: string): boolean {
  const n = (pendingOrganizationToggles.get(organizationId) ?? 0) - 1
  if (n <= 0) {
    pendingOrganizationToggles.delete(organizationId)
    return true
  }
  pendingOrganizationToggles.set(organizationId, n)
  return false
}

// 同 organizationId + canonicalKey 的切换串行链。value 的 promise 是该 key 当前链的「已沉降」副本
// （永不 reject，便于后续入队无缝衔接），organizationId 用于在链排空时归还 organization 计数。
const keyToggleChains = new Map<string, { promise: Promise<unknown>; organizationId: string }>()

/**
 * 按 `organizationId::canonicalKey` 串行执行一次切换，并在整条链排空、且该 organization 内无其它在途切换
 * 时才 invalidate（触发 refetch）。`run` 内通常是 `mutation.mutateAsync(...)`，因此 onMutate /
 * mutationFn / onSettled 都随链排队，保证同 key 的相反操作不会并发、不会把中间态快照写回。
 */
function runSerializedToggle(
  queryClient: QueryClient,
  organizationId: string,
  key: string | undefined,
  run: () => Promise<unknown>,
): Promise<unknown> {
  if (!key) return run()
  const entry = keyToggleChains.get(key)
  const isFirst = !entry
  if (isFirst) beginOrganizationToggle(organizationId)
  const prev = entry?.promise ?? Promise.resolve()
  const next = prev.then(run, run)
  const settled = next.then(
    () => undefined,
    () => undefined,
  )
  keyToggleChains.set(key, { promise: settled, organizationId })
  void settled.finally(() => {
    const cur = keyToggleChains.get(key)
    if (cur?.promise === settled) {
      keyToggleChains.delete(key)
      // 该 key 链已排空；若同时是 organization 内最后一个在途切换，才 refetch，避免中途 refetch
      // 把仍在排队的同 organization 其它切换乐观态冲掉（ 第一轮 review）。
      if (endOrganizationToggle(organizationId)) {
        void queryClient.invalidateQueries({ queryKey: skillKeys.list(organizationId) })
        void queryClient.invalidateQueries({ queryKey: skillKeys.configs(organizationId) })
      }
    }
  })
  return next
}

interface SkillToggleContext {
  claimed: true
  /** 本次 canonicalKey 在 configs 中的原条目（不存在则为 undefined）。 */
  previousConfigEntry: SkillConfig | undefined
  /** 每个缓存的 list 查询里，本次 canonicalKey 对应的原条目（不存在则为 undefined）。 */
  previousListEntries: Array<{
    queryKey: readonly unknown[]
    previousEntry: SkillIndexEntry | undefined
  }>
}

function captureSkillToggleContext(
  queryClient: QueryClient,
  organizationId: string,
  canonicalKey: string,
): SkillToggleContext {
  // ：configs 按 agent 分缓存；前缀扫描取第一份命中作为回滚基线（同 organization 下
  // 各 agent 对该 key 的 enabled 语义在 toggle 路径上一致）。
  const configQueries = queryClient.getQueriesData<Record<string, SkillConfig>>({
    queryKey: skillKeys.configs(organizationId),
  })
  const previousConfigEntry = configQueries
    .map(([, data]) => data?.[canonicalKey])
    .find((entry) => entry !== undefined)

  const previousListEntries = queryClient
    .getQueriesData<SkillIndexEntry[]>({ queryKey: skillKeys.list(organizationId) })
    .map(([queryKey, data]) => ({
      queryKey,
      previousEntry: data?.find((s) => (s.skill_key || s.skill_id) === canonicalKey),
    }))

  return { claimed: true, previousConfigEntry, previousListEntries }
}

/** 仅回滚本次 canonicalKey 的条目，保留其它并发切换的乐观状态。 */
function rollbackSkillToggle(
  queryClient: QueryClient,
  organizationId: string,
  canonicalKey: string,
  context: SkillToggleContext,
): void {
  queryClient.setQueriesData<Record<string, SkillConfig>>(
    { queryKey: skillKeys.configs(organizationId) },
    (old) => {
      if (!old) return old
      const next = { ...old }
      if (context.previousConfigEntry !== undefined) {
        next[canonicalKey] = context.previousConfigEntry
      } else {
        delete next[canonicalKey]
      }
      return next
    },
  )
  for (const { queryKey, previousEntry } of context.previousListEntries) {
    queryClient.setQueryData<SkillIndexEntry[]>(queryKey, (old) => {
      if (!old) return old
      return old.map((skill) => {
        const key = skill.skill_key || skill.skill_id
        if (key !== canonicalKey) return skill
        // 条目原本就在列表里 → 还原；原本不在 → 维持现状（onMutate 未改动它）。
        return previousEntry !== undefined ? previousEntry : skill
      })
    })
  }
}

/**
 * 把 mutation 的 `mutate` / `mutateAsync` 包成按 `spaceId::canonicalKey` 串行，并复用
 * runSerializedToggle 的 space 级 refetch 协调。组件侧无需改动，Switch 仍可交互，但同 key
 * 的相反操作会被自动排队，最终态以用户最后一次操作为准（ 第二轮 review）。
 */
function wrapToggleMutationWithKeySerialization<
  TData,
  TVars extends { canonicalKey: string; spaceId: string },
>(
  queryClient: QueryClient,
  mutation: UseMutationResult<TData, unknown, TVars, SkillToggleContext | undefined>,
): UseMutationResult<TData, unknown, TVars, SkillToggleContext | undefined> {
  const wrapped = {
    ...mutation,
  } as UseMutationResult<TData, unknown, TVars, SkillToggleContext | undefined>
  const run = (
    variables: TVars,
    mutateOptions?: Parameters<typeof mutation.mutateAsync>[1],
  ): Promise<TData> => {
    if (!variables) return mutation.mutateAsync(variables, mutateOptions)
    const organizationId = requireOrganizationIdForSpace(variables.spaceId, 'toggle skill')
    const key = `${organizationId}::${variables.canonicalKey}`
    return runSerializedToggle(queryClient, organizationId, key, () =>
      mutation.mutateAsync(variables, mutateOptions),
    ) as Promise<TData>
  }
  wrapped.mutate = ((variables: TVars, mutateOptions?: Parameters<typeof mutation.mutateAsync>[1]) => {
    void run(variables, mutateOptions)
  }) as typeof wrapped.mutate
  wrapped.mutateAsync = ((variables: TVars, mutateOptions?: Parameters<typeof mutation.mutateAsync>[1]) =>
    run(variables, mutateOptions)) as typeof wrapped.mutateAsync
  return wrapped
}

export function useEnableSkillMutation() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (params: {
      canonicalKey: string
      spaceId: string
      /** ：显式传当前 Agent，打开总闸同时打开该 Agent 子开关 */
      agentId?: string | null
      agents?: AgentDefinition[]
      skill?: SkillIndexEntry
    }) => {
      const organizationId = resolveOrganizationIdForSpace(params.spaceId)
      if (!organizationId) {
        throw new Error('Cannot enable skill: organizationId not resolved for space')
      }
      const body: Record<string, unknown> = { organization_id: organizationId }
      if (params.agentId) body.agent_id = params.agentId
      if (params.agents) body.agents = params.agents
      if (params.skill?.skill_id) body.source_skill_id = params.skill.skill_id
      body.acquire_as_copy = true
      const result = await skillApiRequest<{
        skill_canonical_key: string
        enabled: boolean
        skill?: SkillIndexEntry | null
        installed_version_seq?: number | null
        install_content_hash?: string | null
        agents_sync?: {
          status: 'ok' | 'skipped' | 'failed'
          synced: number
          error?: string | null
        }
        local_install?: 'ok' | 'failed' | 'skipped'
      }>(API_ENDPOINTS.SKILLS.ENABLE(params.canonicalKey), {
        method: 'POST',
        body: JSON.stringify(body),
      })
      //  / ：总闸成功即成功；本机物化失败只记 warn，不回滚、不 throw。
      // user（含无 package）与 app 统一走 ensureSkillMaterializedLocally。
      // 注意：勿在条件里用 isBackendPackageSkill() 类型谓词——false 分支会把
      // SkillIndexEntry 收窄成 never（谓词声明过宽）。
      const enableSkill = result.skill ?? params.skill
      let localResult = result
      if (enableSkill) {
        const enableSource = normalizeSkillSource(enableSkill.source)
        if (enableSource === 'user' || enableSource === 'app') {
          try {
            const local = await ensureSkillMaterializedLocally({
              skill: enableSkill,
              spaceId: params.spaceId,
              versionSeq: result?.installed_version_seq,
            })
            localResult = {
              ...result,
              local_install: local === 'exists' ? ('skipped' as const) : ('ok' as const),
            }
          } catch (err) {
            log.warn('local materialize failed after enable; gate stays on', err)
            localResult = { ...result, local_install: 'failed' as const }
          }
        }
      }
      // ：总闸/子开关变更后失效主进程启用快照
      const agentId = params.agentId
        ?? useSpaceStore.getState().selectedAgent?.id
        ?? undefined
      void invalidateSkillEnablementCache(agentId || undefined)
      return localResult
    },
    // ：技能库 Switch 统一读 list.skill.enabled（用户总闸）；顺带乐观 configs 供配置弹窗。
    onMutate: async (variables) => {
      if (!variables) return undefined
      const organizationId = requireOrganizationIdForSpace(variables.spaceId, 'enable skill')
      await Promise.all([
        queryClient.cancelQueries({ queryKey: skillKeys.configs(organizationId) }),
        queryClient.cancelQueries({ queryKey: skillKeys.list(organizationId) }),
      ])
      const context = captureSkillToggleContext(
        queryClient,
        organizationId,
        variables.canonicalKey,
      )
      queryClient.setQueriesData<Record<string, SkillConfig>>(
        { queryKey: skillKeys.configs(organizationId) },
        (old) => ({
          ...(old ?? {}),
          [variables.canonicalKey]: { ...(old?.[variables.canonicalKey] ?? {}), enabled: true },
        }),
      )
      queryClient.setQueriesData<SkillIndexEntry[]>(
        { queryKey: skillKeys.list(organizationId) },
        (old) => {
          if (!old) return old
          return old.map((skill) => {
            const key = skill.skill_key || skill.skill_id
            if (key !== variables.canonicalKey) return skill
            // acquired / enabled = 用户库总闸；installed / agent_enabled = 当前 Agent 携带。
            // 仅「获取」不得乐观写成已配置给 Agent。
            return {
              ...skill,
              enabled: true,
              acquired: true,
              ...(variables.agentId
                ? { installed: true, agent_enabled: true }
                : {}),
            }
          })
        },
      )
      return context
    },
    onError: (_err, variables, context) => {
      if (!variables || !context) return
      const organizationId = resolveOrganizationIdForSpace(variables.spaceId)
      if (!organizationId) return
      rollbackSkillToggle(queryClient, organizationId, variables.canonicalKey, context)
    },
  })
  return wrapToggleMutationWithKeySerialization(queryClient, mutation)
}

export function useDisableSkillMutation() {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: async (params: {
      canonicalKey: string
      spaceId: string
      skill?: SkillIndexEntry
      removeLocal?: boolean
      forgetAcquisition?: boolean
    }) => {
      // 停用（默认）：后端保留 SkillEnablement 行、仅置 enabled=false，安装记录不丢，
      // 仍留在「已安装」Tab 里灰显、可原地重开。卸载市场包（removeLocal=true）才
      // remove=true 真删行 + 删本地文件，彻底从本 Space 移除。
      // 对 platform 等「无行=默认开」的来源：旧后端无行时 found=false，
      // 内部会 enable→disable 兼容（见 disableSkillWithSoftDefaultFallback）。
      // device 已改为 opt-in（无行=关），不再走 soft-default 兼容。
      const result = await disableSkillWithSoftDefaultFallback(params)
      // disable = 当前 Space 不再注入此 skill，**保留本地文件**。只有 uninstall（卸载市场包，
      // removeLocal=true）才删本地。此前 disable 也删本地，会误删 owner 已发布 skill 的本地
      // 工作副本（isBackendPackageSkill 含 owner 的 package skill）——语义错误。
      if (params.removeLocal && params.skill && result?.found) {
        await uninstallBackendSkillLocally({
          skill: params.skill,
          spaceId: params.spaceId,
        })
      }
      // ：停用后失效主进程启用快照
      const agentId = useSpaceStore.getState().selectedAgent?.id
      void invalidateSkillEnablementCache(agentId || undefined)
      return result
    },
    onMutate: async (variables) => {
      if (!variables || variables.removeLocal) return undefined
      const organizationId = requireOrganizationIdForSpace(variables.spaceId, 'disable skill')
      await Promise.all([
        queryClient.cancelQueries({ queryKey: skillKeys.configs(organizationId) }),
        queryClient.cancelQueries({ queryKey: skillKeys.list(organizationId) }),
      ])
      const context = captureSkillToggleContext(
        queryClient,
        organizationId,
        variables.canonicalKey,
      )
      queryClient.setQueriesData<Record<string, SkillConfig>>(
        { queryKey: skillKeys.configs(organizationId) },
        (old) => ({
          ...(old ?? {}),
          [variables.canonicalKey]: { ...(old?.[variables.canonicalKey] ?? {}), enabled: false },
        }),
      )
      queryClient.setQueriesData<SkillIndexEntry[]>(
        { queryKey: skillKeys.list(organizationId) },
        (old) => {
          if (!old) return old
          return old.map((skill) => {
            const key = skill.skill_key || skill.skill_id
            if (key !== variables.canonicalKey) return skill
            return { ...skill, enabled: false }
          })
        },
      )
      return context
    },
    onError: (_err, variables, context) => {
      if (!variables || !context) return
      const organizationId = resolveOrganizationIdForSpace(variables.spaceId)
      if (!organizationId) return
      rollbackSkillToggle(queryClient, organizationId, variables.canonicalKey, context)
    },
    // 不再在此 onSettled refetch：refetch 改由 runSerializedToggle 在 key 链排空且 space 内
    // 无其它在途切换时统一触发（ 两轮 review）。
  })
  return wrapToggleMutationWithKeySerialization(queryClient, mutation)
}

export function useCreateSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: SkillCreatePayload) => {
      return skillApiRequest<SkillIndexEntry>(API_ENDPOINTS.SKILLS.CREATE, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (data, variables) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.list(variables.organization_id) })
      // 创建接口会在同一事务内按 enable_agent_ids 写 AgentSkillLink。同步失效携带集和
      // 主进程启用快照，确保市场卡片与下一次对话都立即看到新 Skill，而不是等 staleTime/TTL。
      for (const agentId of data.enabled_agent_ids ?? []) {
        void queryClient.invalidateQueries({ queryKey: agentSkillKeys.list(agentId) })
        void invalidateSkillEnablementCache(agentId)
      }
    },
  })
}

export function usePublishSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: { skillId: string } & SkillPublishPayload) => {
      return skillApiRequest<SkillIndexEntry>(
        API_ENDPOINTS.SKILLS.PUBLISH(params.skillId),
        {
          method: 'POST',
          body: JSON.stringify({
            organization_id: params.organization_id,
            version_label: params.version_label,
            visibility: params.visibility,
            change_note: params.change_note,
            files: params.files,
            // 显式传入则覆盖草稿；缺省由后端沿用 Skill.quick_use_json 草稿快照。
            ...(params.quick_use !== undefined ? { quick_use: params.quick_use } : {}),
          }),
        },
      )
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.list(variables.organization_id) })
      void queryClient.invalidateQueries({ queryKey: skillKeys.configs(variables.organization_id) })
      void queryClient.invalidateQueries({ queryKey: [...skillKeys.all, 'versions'] })
      void queryClient.invalidateQueries({ queryKey: [...skillKeys.all, 'content'] })
    },
  })
}

/** 更新「快速使用」preset 列表草稿（写 Skill.quick_use_json；发布时随版本快照）。 */
export function useUpdateSkillQuickUseMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      skillId: string
      spaceId: string
      quickUse: SkillQuickUsePreset[] | null
    }) => {
      const organizationId = requireOrganizationIdForSpace(params.spaceId, 'update skill quick use')
      return skillApiRequest<SkillIndexEntry>(
        API_ENDPOINTS.SKILLS.UPDATE_QUICK_USE(params.skillId),
        {
          method: 'PATCH',
          body: JSON.stringify({
            organization_id: organizationId,
            quick_use: params.quickUse,
          }),
        },
      )
    },
    onSuccess: (_data, variables) => {
      invalidateSkillQueriesForSpace(queryClient, variables.spaceId, ['list'])
      void queryClient.invalidateQueries({ queryKey: [...skillKeys.all, 'content'] })
    },
  })
}

export function useDiscardSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: { skillId: string; spaceId: string }) => {
      return skillApiRequest<{ skill_id: string; discarded: boolean }>(
        API_ENDPOINTS.SKILLS.DISCARD_DRAFT(params.skillId),
        { method: 'DELETE' },
      )
    },
    onSuccess: (_data, variables) => {
      invalidateSkillQueriesForSpace(queryClient, variables.spaceId, ['list'])
    },
  })
}

/**
 * 删除 owner 自己的 user skill（含已发布）。
 *
 * 区别于 {@link useDiscardSkillMutation}（DELETE /skills/{id}/draft，仅未发布草稿）：
 * 本 mutation 走 DELETE /skills/{id}，连同已发布快照（SkillPublishedVersion）一起删。
 * 后端只允许 owner、且在有其他用户启用此 skill 时拒绝（保护团队成员）。
 */
export function useDeleteSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: { skillId: string; spaceId: string }) => {
      return skillApiRequest<{ skill_id: string; deleted: boolean }>(
        API_ENDPOINTS.SKILLS.DELETE_SKILL(params.skillId),
        { method: 'DELETE' },
      )
    },
    onSuccess: (_data, variables) => {
      invalidateSkillQueriesForSpace(queryClient, variables.spaceId, ['list', 'configs', 'visible'])
    },
  })
}

/**
 * 切换 Skill 可见范围（仅 owner，PATCH /skills/{id}/visibility）。
 *
 * 用作「下架」入口：owner 把已发布的 Skill 改为 `private`，让其他人不再能新装。
 * 已经启用此 Skill 的 Space 不受影响（设计选择：保护既有用户）。
 */
export function useUpdateSkillVisibilityMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      skillId: string
      spaceId: string
      visibility: 'private' | 'organization' | 'public'
      organizationId?: string | null
    }) => {
      return skillApiRequest<SkillIndexEntry>(
        API_ENDPOINTS.SKILLS.UPDATE_VISIBILITY(params.skillId),
        {
          method: 'PATCH',
          body: JSON.stringify({
            visibility: params.visibility,
            organization_id: params.organizationId ?? undefined,
          }),
        },
      )
    },
    onSuccess: (_data, variables) => {
      invalidateSkillQueriesForSpace(queryClient, variables.spaceId, ['list', 'visible'])
    },
  })
}

/**
 * 修改 Skill 分类（仅 owner，PATCH /skills/{id}/category）。
 */
export function useUpdateSkillCategoryMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      skillId: string
      spaceId: string
      category: string | null
    }) => {
      const organizationId = requireOrganizationIdForSpace(params.spaceId, 'update skill category')
      return skillApiRequest<SkillIndexEntry>(
        API_ENDPOINTS.SKILLS.UPDATE_CATEGORY(params.skillId),
        {
          method: 'PATCH',
          body: JSON.stringify({
            organization_id: organizationId,
            category: params.category || null,
          }),
        },
      )
    },
    onSuccess: (_data, variables) => {
      invalidateSkillQueriesForSpace(queryClient, variables.spaceId, ['list'])
      void queryClient.invalidateQueries({ queryKey: [...skillKeys.all, 'content'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Revert（保留：与 Package Registry 的版本回滚动作对齐）
// ---------------------------------------------------------------------------

export function useRevertSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      packageId: string
      targetVersionSeq: number
      skillKey?: string
    }): Promise<{ new_version_seq?: number; new_version_label?: string }> => {
      const data = await skillApiRequest<{
        new_version_seq?: number
        new_version_label?: string
      }>(
        `/services/package-registry/packages/${params.packageId}/versions/${params.targetVersionSeq}/revert`,
        { method: 'POST' },
      )
      return data ?? {}
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: skillKeys.versions(variables.packageId),
      })
      void queryClient.invalidateQueries({ queryKey: skillKeys.all })
    },
  })
}

// ---------------------------------------------------------------------------
// Wave 4: 版本列表 / 升级 / 导入 / 另存为我的副本
// ---------------------------------------------------------------------------

export function useSkillVersionsListQuery(skillId: string | null) {
  return useQuery({
    queryKey: [...skillKeys.all, 'skill-versions', skillId ?? ''],
    queryFn: async (): Promise<SkillVersion[]> => {
      const data = await skillApiRequest<{ versions: SkillVersion[] }>(
        API_ENDPOINTS.SKILLS.VERSIONS(skillId!),
      )
      return data?.versions ?? []
    },
    enabled: !!skillId,
    staleTime: 60_000,
  })
}

export function useActivateSkillVersionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      skillId: string
      skill: SkillIndexEntry
      /** 本地 IPC 落盘用 workspace；HTTP 只用 organization_id + agent_id */
      spaceId: string
    } & SkillActivateVersionPayload) => {
      const result = await skillApiRequest<{
        installed_version_seq?: number
        version_label?: string
        install_content_hash?: string
        package_id?: string
      }>(
        API_ENDPOINTS.SKILLS.ACTIVATE_VERSION(params.skillId),
        {
          method: 'POST',
          body: JSON.stringify({
            organization_id: params.organization_id,
            agent_id: params.agent_id,
            version_seq: params.version_seq,
          }),
        },
      )
      const versionSeq = result?.installed_version_seq ?? params.version_seq
      if (params.skill.package_id) {
        await installBackendSkillLocally({
          skill: params.skill,
          spaceId: params.spaceId,
          versionSeq,
          force: true,
        })
      }
      return result
    },
    onSuccess: (data, variables) => {
      const installedSeq = data?.installed_version_seq ?? variables.version_seq
      const installedLabel = (data?.version_label || '').trim() || null
      // 立刻写回列表缓存，避免 refetch 前详情徽章仍显示旧 seq / 误用 v{seq}。
      queryClient.setQueriesData<SkillIndexEntry[]>(
        { queryKey: [...skillKeys.all, 'list'] },
        (old) => {
          if (!Array.isArray(old)) return old
          return old.map((entry) => {
            if (entry.skill_id !== variables.skillId) return entry
            return {
              ...entry,
              installed_version_seq: installedSeq,
              installed_version_label: installedLabel ?? entry.installed_version_label,
            }
          })
        },
      )
    },
    onSettled: (_data, _error, variables) => {
      if (!variables) return
      void queryClient.invalidateQueries({ queryKey: skillKeys.list(variables.organization_id) })
      void queryClient.invalidateQueries({
        queryKey: [...skillKeys.all, 'skill-versions', variables.skillId],
      })
      void queryClient.invalidateQueries({ queryKey: [...skillKeys.all, 'content'] })
    },
  })
}

export function useUpgradeSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: {
      skillId: string
      skill?: SkillIndexEntry
      spaceId: string
    } & SkillUpgradePayload) => {
      const result = await skillApiRequest<SkillUpgradeResult>(
        API_ENDPOINTS.SKILLS.UPGRADE(params.skillId),
        {
          method: 'POST',
          body: JSON.stringify({
            organization_id: params.organization_id,
            agent_id: params.agent_id,
            resolution: params.resolution,
          }),
        },
      )
      if (result?.status === 'upgraded' && isBackendPackageSkill(params.skill)) {
        const versionSeq = result.installed_version_seq
        if (!versionSeq) {
          throw new Error('Upgraded skill has no published version to install locally')
        }
        await installBackendSkillLocally({
          skill: params.skill,
          spaceId: params.spaceId,
          versionSeq,
          force: true,
        })
      }
      return result
    },
    onSettled: (_data, _error, variables) => {
      if (!variables) return
      void queryClient.invalidateQueries({ queryKey: skillKeys.list(variables.organization_id) })
      void queryClient.invalidateQueries({ queryKey: skillKeys.configs(variables.organization_id) })
    },
  })
}

export function useImportSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: SkillImportPayload) => {
      return skillApiRequest<SkillImportResult>(
        API_ENDPOINTS.SKILLS.IMPORT,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      )
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: skillKeys.list(variables.organization_id) })
    },
  })
}

export function useExportSkillMutation() {
  return useMutation({
    mutationFn: async (params: { skillId: string }) => {
      const token = useAuthStore.getState().accessToken
      const resp = await electronFetch(
        joinApiPath(API_CONFIG.baseURL, API_ENDPOINTS.SKILLS.EXPORT(params.skillId)),
        {
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      )
      if (!resp.ok) {
        throw new Error(`Export failed: ${resp.status}`)
      }
      const blob = await resp.blob()
      const disposition = resp.headers.get('Content-Disposition') || ''
      const match = disposition.match(/filename="?(.+?)"?$/)
      const filename = match?.[1] || 'skill-export.zip'
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      setTimeout(() => {
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      }, 10_000)
      return { filename }
    },
  })
}

export function useSaveAsCopyMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (params: { sourceSkillId: string; spaceId: string; agentId?: string | null }) => {
      const organizationId = resolveOrganizationIdForSpace(params.spaceId)
      if (!organizationId) {
        throw new Error('Cannot save-as-copy: organizationId not resolved for space')
      }
      return skillApiRequest<SkillIndexEntry>(
        API_ENDPOINTS.SKILLS.SAVE_AS_COPY,
        {
          method: 'POST',
          body: JSON.stringify({
            organization_id: organizationId,
            agent_id: params.agentId ?? undefined,
            source_skill_id: params.sourceSkillId,
          }),
        },
      )
    },
    onSuccess: (_data, variables) => {
      invalidateSkillQueriesForSpace(queryClient, variables.spaceId, ['list'])
    },
  })
}

// ---------------------------------------------------------------------------
// SkillEnablement.config_json 读写（迁移自 SpaceAppSettings.skill_configs）
// ---------------------------------------------------------------------------

export function useUpdateSkillConfigMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (payload: SkillConfigUpdatePayload) => {
      const data = await skillApiRequest<{ config: SkillConfig }>(
        API_ENDPOINTS.SKILLS.CONFIG_UPDATE(payload.skill_key),
        {
          method: 'PATCH',
          body: JSON.stringify({
            ...payload,
            // 后端 schema 字段名是 skill_canonical_key，前端历史名为 skill_key —
            // 透传两者保证后端 path 校验不抛错。
            skill_canonical_key: payload.skill_key,
          }),
        },
      )
      return data?.config ?? null
    },
    onSuccess: (_data, payload) => {
      void queryClient.invalidateQueries({
        queryKey: skillKeys.configs(payload.organization_id),
      })
      // Wave 1.5（保留）：清主进程 60s LRU 凭据缓存，避免凭据切换后旧密钥继续被注入。
      try {
        const browserApi = (window as unknown as {
          tabtin?: {
            agentEngine?: {
              invalidateSkillCredentialCache?: (
                filter?: { spaceId?: string; skillKey?: string },
              ) => Promise<unknown>
            }
          }
        }).tabtin?.agentEngine?.invalidateSkillCredentialCache
        if (browserApi && payload.organization_id && payload.skill_key) {
          void browserApi({ spaceId: payload.organization_id, skillKey: payload.skill_key })
        }
      } catch {
        // fail-soft: 主进程 IPC 失败不影响 mutation 主流程，60s LRU 缓存自然过期
      }
    },
  })
}
