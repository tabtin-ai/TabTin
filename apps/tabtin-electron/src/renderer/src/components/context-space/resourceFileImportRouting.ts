import {
  TABDOC_IMPORT_EXTENSIONS,
  TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION,
} from './tabdocImportRouting'
import { TABSLIDE_UI_ENABLED } from '@/utils/featureFlags'

export type ImportableResourceAppId = 'tabdata' | 'tabdoc' | 'tabslide'
/** 云盘统一导入：可转换成业务资源，或作为裸文件挂载 */
export type CloudDriveImportAppId = ImportableResourceAppId | 'tabfiles'

interface ResourceImportConfig {
  importExtensions: readonly string[]
  maxImportSizeBytes: number
  maxImportSizeBytesByExtension?: Record<string, number>
}

export const RESOURCE_IMPORT_CONFIG: Record<ImportableResourceAppId, ResourceImportConfig> = {
  tabdata: {
    //  / ：与表内 DataImportDialog、后端 /tabdata/import/json 对齐，首页/应用页导入放行 .json
    importExtensions: ['csv', 'xlsx', 'xls', 'json'],
    maxImportSizeBytes: 25 * 1024 * 1024,
    // 后端 _MAX_TEXT_IMPORT_BYTES（CSV/JSON body）为 10MB
    maxImportSizeBytesByExtension: {
      json: 10 * 1024 * 1024,
    },
  },
  tabdoc: {
    importExtensions: TABDOC_IMPORT_EXTENSIONS,
    maxImportSizeBytes: 5 * 1024 * 1024,
    maxImportSizeBytesByExtension: TABDOC_IMPORT_MAX_SIZE_BY_EXTENSION,
  },
  tabslide: {
    // ：TabSlide App UI 隐藏期间，.pptx 不再导入成 tabslide 项目
    //（否则只会打开「应用已下架」占位）——留空后由云盘作为裸文件挂载。
    importExtensions: TABSLIDE_UI_ENABLED ? ['pptx'] : [],
    maxImportSizeBytes: 50 * 1024 * 1024,
  },
}

/** 云盘裸文件上传上限，与 OSS CLI / 直传口径对齐 */
export const TABFILES_IMPORT_MAX_SIZE_BYTES = 100 * 1024 * 1024

function buildAccept(extensions: readonly string[]): string {
  return extensions.map(extension => `.${extension}`).join(',')
}

export const RESOURCE_IMPORT_ACCEPT_BY_APP_ID: Record<ImportableResourceAppId, string> = {
  tabdata: buildAccept(RESOURCE_IMPORT_CONFIG.tabdata.importExtensions),
  tabdoc: buildAccept(RESOURCE_IMPORT_CONFIG.tabdoc.importExtensions),
  tabslide: buildAccept(RESOURCE_IMPORT_CONFIG.tabslide.importExtensions),
}

/** 各应用页导入白名单拼接；云盘入口不限制类型，勿把此常量绑到云盘 file input */
export const RESOURCE_IMPORT_ACCEPT = Object.values(RESOURCE_IMPORT_ACCEPT_BY_APP_ID)
  .filter(Boolean)
  .join(',')

export function fileExtension(fileName: string): string {
  return fileName.split('.').pop()?.toLowerCase() ?? ''
}

export function getImportedResourceTitle(
  fileName: string,
  fallback: string,
  preferredTitle: string | null | undefined = fileName,
): string {
  const title = (preferredTitle || fileName).trim()
  const extension = fileExtension(fileName)
  const matchingSuffix = extension ? `.${extension}` : ''
  const stripped = matchingSuffix && title.toLowerCase().endsWith(matchingSuffix)
    ? title.slice(0, -matchingSuffix.length).trim()
    : title
  return stripped || fallback
}

export function formatResourceImportFormats(
  accept: string,
  language: string | undefined,
): string {
  const separator = language?.startsWith('zh') ? '、' : ', '
  return accept.split(',').join(separator)
}

export function resolveResourceImportTargetAppId(
  fileName: string,
  requestedAppId?: ImportableResourceAppId,
): CloudDriveImportAppId | null {
  if (requestedAppId === undefined) return 'tabfiles'

  const extension = fileExtension(fileName)
  return RESOURCE_IMPORT_CONFIG[requestedAppId].importExtensions.includes(extension)
    ? requestedAppId
    : null
}

export function getImportMaxSizeBytes(
  appId: ImportableResourceAppId,
  extension: string,
): number {
  const config = RESOURCE_IMPORT_CONFIG[appId]
  return config.maxImportSizeBytesByExtension?.[extension] ?? config.maxImportSizeBytes
}
