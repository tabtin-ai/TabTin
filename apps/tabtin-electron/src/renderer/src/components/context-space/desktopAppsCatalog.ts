/**
 * Manifest catalog 静态读取（ P3：桌面应用分组改为 manifest 驱动）。
 *
 * 数据源：`packages/apps/<id>/app.json` 经 `import.meta.glob` 在构建期打包进
 * 渲染进程（与 registry/index.ts 的 resourceRouter opens 注册同款手法），与后端
 * `apps/services/common/app_registry` 扫描的是同一份 manifest SSoT——因此这里
 * 读到的 `catalog.desktopGroup / order / distribution` 与后端 `GET /spaces/{id}/apps`
 * 下发的 `desktop_group / order / distribution` 语义一致，且**同步可得**（不依赖
 * 网络时序），适合作为「更多应用」分组的第一优先数据源。
 *
 * 本模块是 leaf 模块：只依赖 logger 与打包 JSON，不 import registry / store，
 * 不参与 desktopAppsModel ↔ registry 的循环依赖（见 desktopAppsConstants.ts 的
 * TDZ 说明）。
 */
import { createLogger } from '@/utils/logger'

const log = createLogger('DesktopAppsCatalog')

/** 「更多应用」三分组 id（与 desktopAppsModel 的 DESKTOP_APP_GROUP_ORDER 对齐）。 */
export type DesktopAppSectionId = 'collaborative' | 'local' | 'other'

/**
 * manifest `catalog.desktopGroup` → 「更多应用」三分组映射。
 *
 * 刻意**不映射** `capabilities`：该组混杂执行设备型本机能力
 * （tabweb / tabdesktop / orchestration），无法整组归入协作或单机。
 * 未映射的 desktopGroup 落到保障名单兜底（desktopAppsModel）。
 */
const DESKTOP_GROUP_TO_SECTION: Record<string, DesktopAppSectionId> = {
  cloudResources: 'collaborative',
  // 历史值兼容（与 DesktopPanel.normalizeDesktopGroup 同口径）
  content: 'collaborative',
  localResources: 'local',
  local: 'local',
  extensions: 'other',
}

export interface DesktopAppCatalogEntry {
  appId: string
  desktopGroup?: string
  order?: number
  distribution?: string
  isDefaultEnabled?: boolean
}

interface RawManifest {
  id?: unknown
  distribution?: unknown
  catalog?: {
    desktopGroup?: unknown
    order?: unknown
    isDefaultEnabled?: unknown
  }
}

// 构建期静态聚合 builtin + repo 内 marketplace manifest（运行时零 IO）。
// 路径为本文件（components/context-space/）到 repo root 的 7 级相对路径。
const manifestModules = import.meta.glob<RawManifest>(
  '../../../../../../../packages/apps/*/app.json',
  { eager: true, import: 'default' },
)

function parseManifest(path: string, manifest: RawManifest): DesktopAppCatalogEntry | null {
  if (!manifest || typeof manifest !== 'object') {
    log.warn('manifest 非对象，跳过', { path })
    return null
  }
  const appId = manifest.id
  if (typeof appId !== 'string' || !appId) {
    log.warn('manifest 缺 id，跳过', { path })
    return null
  }
  const catalog = manifest.catalog
  const desktopGroup = typeof catalog?.desktopGroup === 'string' && catalog.desktopGroup
    ? catalog.desktopGroup
    : undefined
  const order = typeof catalog?.order === 'number' && Number.isFinite(catalog.order)
    ? catalog.order
    : undefined
  const distribution = typeof manifest.distribution === 'string' && manifest.distribution
    ? manifest.distribution
    : undefined
  const isDefaultEnabled = typeof catalog?.isDefaultEnabled === 'boolean'
    ? catalog.isDefaultEnabled
    : undefined
  return { appId, desktopGroup, order, distribution, isDefaultEnabled }
}

function buildCatalogIndex(): Map<string, DesktopAppCatalogEntry> {
  const index = new Map<string, DesktopAppCatalogEntry>()
  for (const [path, manifest] of Object.entries(manifestModules)) {
    const entry = parseManifest(path, manifest)
    if (!entry) continue
    index.set(entry.appId, entry)
  }
  return index
}

const catalogIndex = buildCatalogIndex()

/** 读取 app 的 manifest catalog 条目；repo 内无 manifest（如 skill、远端安装 app）返回 undefined。 */
export function getManifestCatalogEntry(appId: string): DesktopAppCatalogEntry | undefined {
  return catalogIndex.get(appId)
}

/**
 * 依 manifest `catalog.desktopGroup` 解析「更多应用」分组。
 * 返回 null 表示 manifest 无法回答（manifest 缺失 / 未声明 desktopGroup /
 * desktopGroup 属于未映射组如 capabilities）——调用方走保障名单兜底。
 */
export function resolveSectionFromManifest(appId: string): DesktopAppSectionId | null {
  const desktopGroup = catalogIndex.get(appId)?.desktopGroup
  if (!desktopGroup) return null
  return DESKTOP_GROUP_TO_SECTION[desktopGroup] ?? null
}

/** manifest `catalog.order`（组内排序权重）；缺失返回 undefined，调用方排末尾。 */
export function getManifestOrder(appId: string): number | undefined {
  return catalogIndex.get(appId)?.order
}

/** manifest `distribution`（builtin / marketplace，用于卡片标签兜底）。 */
export function getManifestDistribution(appId: string): string | undefined {
  return catalogIndex.get(appId)?.distribution
}
