import type { TFunction } from 'i18next'
import { contextRegistry } from '../../context-space/registry'
import { resolveAppHomeTabModel } from '../../context-space/registry/resolveUtils'
import type { ContextItemType } from '../../context-space/registry/types'

const CRAWLSPACE_RAW_TITLE_KEYS = new Set(['tabs.untitled', 'tabs.newTabTitle'])

export interface ChatContextDisplay {
  icon: string
  label: string
  name?: string | null
  type: 'chat'
}

export interface ResolveChatContextDisplayInput {
  activeContextKey: string | null
  activeContextType: string | null
  activeTable: { name: string } | null
  activeAppMeta: Record<string, unknown> | null
  activeTabTitle: string | null
  activeTabMeta: Record<string, unknown> | null | undefined
  spaceName: string | null | undefined
  t: TFunction<'chat'>
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isUsableBrowserTabTitle(value: string | null): value is string {
  if (!value) return false
  if (/^https?:\/\//i.test(value)) return false
  if (CRAWLSPACE_RAW_TITLE_KEYS.has(value)) return false
  return true
}

function resolveAppKey(
  activeContextType: string,
  activeTabMeta: Record<string, unknown> | null | undefined,
): string {
  if (activeContextType === 'apphome') {
    return readNonEmptyString(activeTabMeta?.appId) ?? activeContextType
  }
  return activeContextType
}

function resolveContextLabel(
  activeContextType: string | null,
  activeTabMeta: Record<string, unknown> | null | undefined,
  t: TFunction<'chat'>,
): string {
  if (!activeContextType) {
    return t('panel.contextAgent')
  }
  if (activeContextType === 'tabdata') {
    return t('panel.contextTable')
  }
  if (activeContextType === 'tabweb') {
    return t('panel.contextWeb')
  }
  return contextRegistry.getAgentDisplayName(resolveAppKey(activeContextType, activeTabMeta))
}

function resolveTitleFromAppMeta(
  activeContextType: string,
  activeAppMeta: Record<string, unknown>,
): string | null {
  const appMeta = contextRegistry.getAppMeta(activeContextType as ContextItemType)
  if (appMeta?.titleField) {
    const fromTitleField = readNonEmptyString(activeAppMeta[appMeta.titleField])
    if (fromTitleField) return fromTitleField
  }

  if (activeContextType === 'terminal') {
    return readNonEmptyString(activeAppMeta.current_terminal_cwd)
  }

  if (activeContextType === 'tabcode') {
    const codePath = readNonEmptyString(activeAppMeta.current_code_project_path)
    if (!codePath) return null
    const selectedFile = readNonEmptyString(activeAppMeta.current_code_file)
    if (selectedFile) return selectedFile
    const segments = codePath.split('/').filter(Boolean)
    return segments[segments.length - 1] ?? codePath
  }

  if (activeContextType === 'tabfolder') {
    const selectedFile = readNonEmptyString(activeAppMeta.current_file_path)
    if (selectedFile) return selectedFile
    const folderPath = readNonEmptyString(
      activeAppMeta.current_folder_path ?? activeAppMeta.sandbox_path,
    )
    if (!folderPath) return null
    const segments = folderPath.split(/[\\/]/).filter(Boolean)
    return segments[segments.length - 1] ?? folderPath
  }

  return null
}

function resolveContextName(input: ResolveChatContextDisplayInput): string | null {
  const {
    activeContextKey,
    activeContextType,
    activeTable,
    activeAppMeta,
    activeTabTitle,
    activeTabMeta,
    spaceName,
    t,
  } = input

  if (!activeContextKey || !activeContextType) {
    return readNonEmptyString(spaceName)
  }

  if (activeContextType === 'tabdata' && activeTable?.name) {
    return activeTable.name
  }

  if (activeContextType === 'tabweb') {
    const browserTitle = activeAppMeta
      ? readNonEmptyString(activeAppMeta.current_browser_title)
      : null
    const tabTitle = readNonEmptyString(activeTabTitle)
    if (isUsableBrowserTabTitle(browserTitle)) return browserTitle
    if (isUsableBrowserTabTitle(tabTitle)) return tabTitle
    return t('panel.contextNewWebTab')
  }

  if (activeAppMeta) {
    const fromAppMeta = resolveTitleFromAppMeta(activeContextType, activeAppMeta)
    if (fromAppMeta) return fromAppMeta
  }

  if (activeTabTitle) return activeTabTitle

  if (activeContextType === 'apphome') {
    const appId = readNonEmptyString(activeTabMeta?.appId)
    if (appId) {
      return resolveAppHomeTabModel(appId, {
        title: activeTabTitle ?? undefined,
        meta: activeTabMeta ?? undefined,
      }).title
    }
  }

  return null
}

export function resolveChatContextDisplay(
  input: ResolveChatContextDisplayInput,
): ChatContextDisplay {
  const { activeContextType, activeTabMeta, t } = input

  return {
    icon: activeContextType === 'tabweb' ? '🌐' : '📍',
    label: resolveContextLabel(activeContextType, activeTabMeta, t),
    name: resolveContextName(input),
    type: 'chat',
  }
}
