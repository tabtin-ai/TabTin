import type { ContextBlock } from './ContextRefCard'
import { useSpaceStore } from '@/stores/useSpaceStore'

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() || normalized
}

function isAbsolutePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/')
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)
}

function normalizePath(path: string): string {
  const raw = path.replace(/\\/g, '/')
  const drive = raw.match(/^([A-Za-z]:)(?:\/|$)/)?.[1] ?? ''
  const absoluteRoot = drive ? '' : (raw.startsWith('/') ? '/' : '')
  const prefix = drive || absoluteRoot
  let rest = raw.slice(prefix.length)
  if (drive && rest.startsWith('/')) rest = rest.slice(1)

  const parts: string[] = []
  for (const segment of rest.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') {
        parts.pop()
      } else if (!prefix) {
        parts.push(segment)
      }
      continue
    }
    parts.push(segment)
  }

  const normalizedRest = parts.join('/')
  if (drive) return normalizedRest ? `${drive}/${normalizedRest}` : `${drive}/`
  if (absoluteRoot) return normalizedRest ? `/${normalizedRest}` : '/'
  return normalizedRest
}

export function isInsideRoot(absolutePath: string, rootPath: string): boolean {
  const normalizedPath = normalizePath(absolutePath)
  const normalizedRoot = normalizePath(rootPath)
  if (!normalizedPath || !normalizedRoot) return false
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function encodeTabCodeId(rootPath: string): string {
  return btoa(unescape(encodeURIComponent(rootPath)))
}

function makeTarget(rootPath: string, absoluteFilePath: string): ContextCodeNavigationTarget {
  return {
    rootPath,
    absoluteFilePath,
    tabId: encodeTabCodeId(rootPath),
    title: basename(rootPath) || 'TabCode',
  }
}

export interface ContextCodeNavigationTarget {
  rootPath: string
  absoluteFilePath: string
  tabId: string
  title: string
}

export interface ResolveContextCodeNavigationOptions {
  /**
   * 已打开且可能包含该文件的 TabCode/TabFolder 根。
   * 与显式 `root_path`、Agent working_dir 相比优先选用（最长匹配）。
   */
  preferredRootPaths?: Array<string | null | undefined>
}

export async function readAgentWorkingDirForSpace(spaceId: string): Promise<string> {
  const state = useSpaceStore.getState()
  const space = state.spaces.find((item) => item.id === spaceId)
    ?? (state.selectedSpace?.id === spaceId ? state.selectedSpace : null)
  if (!space || space.type !== 'workspace') return ''
  if (space.working_dir) return space.working_dir

  const agentId = space?.execution_agent_id ?? space?.agent_id ?? null
  if (agentId) {
    const cached = state.agentCache[agentId]
    if (cached) return cached.working_dir ?? ''

    try {
      const fetched = await state.loadAgent(agentId)
      if (fetched) return fetched.working_dir ?? ''
    } catch (err) {
      console.warn('[contextCodeNavigation] loadAgent fallback failed:', err)
    }
  }

  return ''
}

/**
 * 解析代码引用导航目标。
 *
 * 根选择优先级：
 * 1. `preferredRootPaths` 中包含该文件的最长根（已打开 TabCode/TabFolder）
 * 2. 引用自身的显式 `root_path`（不必等于 Agent working_dir）
 * 3. 无显式 root 时回退 Agent working_dir
 *
 * 始终要求绝对文件路径落在所选 root 内，防止任意路径越界。
 */
export function resolveContextCodeNavigationTarget(
  block: Pick<ContextBlock, 'file_path' | 'root_path'>,
  fallbackRootPath: string | null | undefined,
  options?: ResolveContextCodeNavigationOptions,
): ContextCodeNavigationTarget | null {
  const filePath = typeof block.file_path === 'string' ? block.file_path.trim() : ''
  if (!filePath) return null

  const fallbackRoot = normalizePath((fallbackRootPath ?? '').trim())
  const explicitRoot = typeof block.root_path === 'string' && block.root_path.trim()
    ? normalizePath(block.root_path)
    : ''

  const rootForRelative = explicitRoot || fallbackRoot
  if (!isAbsolutePath(filePath) && !rootForRelative) return null

  const absoluteFilePath = isAbsolutePath(filePath)
    ? normalizePath(filePath)
    : normalizePath(`${rootForRelative}/${filePath}`)

  const preferredRoots = (options?.preferredRootPaths ?? [])
    .map((path) => normalizePath((path ?? '').trim()))
    .filter((path): path is string => Boolean(path))
    .filter((root) => isInsideRoot(absoluteFilePath, root))
    .sort((a, b) => b.length - a.length)

  if (preferredRoots[0]) {
    return makeTarget(preferredRoots[0], absoluteFilePath)
  }

  if (explicitRoot) {
    if (!isInsideRoot(absoluteFilePath, explicitRoot)) return null
    return makeTarget(explicitRoot, absoluteFilePath)
  }

  if (fallbackRoot) {
    if (!isInsideRoot(absoluteFilePath, fallbackRoot)) return null
    return makeTarget(fallbackRoot, absoluteFilePath)
  }

  return null
}
