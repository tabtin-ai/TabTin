import type { OpenOutcome } from '@tabtin/resource-router'
import { buildRichResourcePointer } from './buildRichResourcePointer'
import type { ContextBlock } from './ContextRefCard'
import { isWebContextRefBlock } from './ContextRefCard'
import {
  readAgentWorkingDirForSpace,
  resolveContextCodeNavigationTarget,
} from './contextCodeNavigation'

export interface ContextBlockNavigationParams {
  block: ContextBlock
  selectedSpaceId: string | null
  tabScopeKey: string | null
}

export interface ContextBlockNavigationDeps {
  expandCanvasAfterInSpaceOpen: (tabScopeKey: string, outcome: OpenOutcome) => void
  expandCanvasForScope: (tabScopeKey: string) => void
  reportRichResourceOpenFailure: (
    outcome: OpenOutcome,
    options?: { modifierExternal?: boolean },
  ) => void
  warn: (message: string, ...args: unknown[]) => void
  toastNoSpace: () => void
  toastOpenFailed: (description?: string) => void
}

function resolveNavigationContext(params: ContextBlockNavigationParams): {
  spaceId: string
  targetTabScopeKey: string
} | null {
  const spaceId = params.block.space_id ?? params.selectedSpaceId ?? ''
  if (!spaceId) return null
  return {
    spaceId,
    targetTabScopeKey: params.tabScopeKey || params.selectedSpaceId || spaceId,
  }
}

async function navigateRichResourceBlock(
  block: ContextBlock,
  spaceId: string,
  targetTabScopeKey: string,
  deps: ContextBlockNavigationDeps,
): Promise<void> {
  const [
    { ensureSpaceSelectedWithFeedback },
    { resourceRouter },
  ] = await Promise.all([
    import('@/services/spaceNavigation'),
    import('@/services/resourceRouter'),
  ])
  const didSelect = await ensureSpaceSelectedWithFeedback(spaceId, {})
  if (!didSelect) return
  if (!block.type || !block.resource_id) return
  const pointer = buildRichResourcePointer(
    block.type,
    block.resource_id,
    block.hint_carrier_app_id,
  )
  const outcome = await resourceRouter.open(spaceId, pointer, {
    tabScopeKey: targetTabScopeKey,
    triggerSource: 'rich_resource_card',
    ...(block.modifierExternal ? { modifierExternal: true } : {}),
  })
  deps.expandCanvasAfterInSpaceOpen(targetTabScopeKey, outcome)
  deps.reportRichResourceOpenFailure(outcome, {
    modifierExternal: block.modifierExternal,
  })
}

type OpenTabRootHit = {
  rootPath: string
  type: 'tabcode' | 'tabfolder'
  id: string
  title: string
}

function positiveLine(value: unknown): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined
}

function findPreferredOpenTabRoot(
  block: ContextBlock,
  workingDir: string,
  targetTabScopeKey: string,
  findContainingOpenTabRoot: (absoluteFilePath: string, tabScopeKey: string) => OpenTabRootHit | null,
): OpenTabRootHit | null {
  const preliminary = resolveContextCodeNavigationTarget(block, workingDir)
  if (preliminary) {
    const hit = findContainingOpenTabRoot(preliminary.absoluteFilePath, targetTabScopeKey)
    if (hit) return hit
  }
  if (typeof block.file_path !== 'string') return null
  const absoluteGuess = block.file_path.replace(/\\/g, '/').trim()
  const looksAbsolute = absoluteGuess.startsWith('/') || /^[A-Za-z]:\//.test(absoluteGuess)
  if (!looksAbsolute) return null
  return findContainingOpenTabRoot(absoluteGuess, targetTabScopeKey)
}

async function ensureCodeNavigationSessionAllow(
  spaceId: string,
  workingDir: string,
  target: { rootPath: string; absoluteFilePath: string },
  isInsideWorkingDir: (absoluteFile: string, workingDir: string) => boolean,
  deps: ContextBlockNavigationDeps,
): Promise<boolean> {
  const needsAllow = !isInsideWorkingDir(target.absoluteFilePath, workingDir)
    || !isInsideWorkingDir(target.rootPath, workingDir)
  if (!needsAllow) return true
  const appendSessionAllowedPath = window.tabtin?.workspace?.appendSessionAllowedPath
  if (!appendSessionAllowedPath) {
    deps.warn('[ChatPanel] code context session allow bridge unavailable')
    deps.toastOpenFailed()
    return false
  }
  try {
    await appendSessionAllowedPath({
      spaceId,
      path: target.absoluteFilePath,
    })
    if (target.rootPath !== target.absoluteFilePath) {
      await appendSessionAllowedPath({
        spaceId,
        path: target.rootPath,
      })
    }
    return true
  } catch (err) {
    deps.warn('[ChatPanel] code context session allow failed:', err)
    deps.toastOpenFailed(err instanceof Error ? err.message : String(err))
    return false
  }
}

async function navigateCodeContextBlock(
  block: ContextBlock,
  spaceId: string,
  targetTabScopeKey: string,
  deps: ContextBlockNavigationDeps,
): Promise<void> {
  const [
    { useSpaceContextTabsStore },
    { useTabCodeStore },
    { findContainingOpenTabRoot, isInsideWorkingDir },
  ] = await Promise.all([
    import('@/stores/useSpaceContextTabsStore'),
    import('@components/tabcode/hooks/useTabCodeStore'),
    import('@components/chat/cards/hooks/useFileOpenAction'),
  ])
  const workingDir = await readAgentWorkingDirForSpace(spaceId)
  const openHit = findPreferredOpenTabRoot(
    block,
    workingDir,
    targetTabScopeKey,
    findContainingOpenTabRoot,
  )
  const target = resolveContextCodeNavigationTarget(block, workingDir, {
    preferredRootPaths: openHit ? [openHit.rootPath] : [],
  })
  if (!target) {
    deps.warn('[ChatPanel] code context source navigate skipped: unresolved root/file path', block)
    deps.toastOpenFailed()
    return
  }

  const reuseOpenTab = Boolean(openHit && openHit.rootPath === target.rootPath)
  const tabType = reuseOpenTab && openHit ? openHit.type : 'tabcode'
  const tabId = reuseOpenTab && openHit ? openHit.id : target.tabId
  const title = reuseOpenTab && openHit ? openHit.title : target.title

  if (!(await ensureCodeNavigationSessionAllow(
    spaceId,
    workingDir,
    target,
    isInsideWorkingDir,
    deps,
  ))) {
    return
  }

  deps.expandCanvasForScope(targetTabScopeKey)
  useTabCodeStore.getState().setPendingReveal(target.rootPath, {
    filePath: target.absoluteFilePath,
    line: positiveLine(block.start_line),
    endLine: positiveLine(block.end_line),
    requestId: Date.now(),
  })
  useSpaceContextTabsStore.getState().openResourceTab(targetTabScopeKey, {
    type: tabType,
    id: tabId,
    title,
    meta: tabType === 'tabfolder'
      ? { path: target.rootPath, kind: 'user', spaceId }
      : { path: target.rootPath, spaceId },
  })
}

async function navigateWebContextBlock(
  block: ContextBlock,
  spaceId: string,
  targetTabScopeKey: string,
  deps: ContextBlockNavigationDeps,
): Promise<void> {
  const url = block.url || ''
  if (!url) return
  const { focusExistingWebTabInSpace, openWebTabInSpace } = await import('@/services/openWebTabInSpace')
  const focused = await focusExistingWebTabInSpace(spaceId, url, { tabScopeKey: targetTabScopeKey })
  const opened = focused
    || (await openWebTabInSpace(spaceId, url, {
      title: block.page_title || url,
      tabScopeKey: targetTabScopeKey,
    })).ok
  if (!opened) {
    void window.tabtin?.openExternal?.(url)
  } else {
    deps.expandCanvasForScope(targetTabScopeKey)
  }
}

async function navigateDocContextBlock(
  block: ContextBlock,
  spaceId: string,
  targetTabScopeKey: string,
  deps: ContextBlockNavigationDeps,
): Promise<void> {
  const docId = block.doc_id || ''
  const blockIds = Array.isArray(block.block_ids)
    ? block.block_ids.filter(id => typeof id === 'string' && id.trim())
    : []
  const fullText = typeof block.full_text === 'string' && block.full_text.trim()
    ? block.full_text
    : ''
  const shouldReveal = !!docId && (blockIds.length > 0 || fullText.trim().length > 0)
  if (!shouldReveal) return

  const { contextRegistry } = await import('@components/context-space/registry')
  const { useTabDocRevealStore } = await import('@/stores/useTabDocRevealStore')
  useTabDocRevealStore.getState().setPendingReveal(docId, {
    kind: 'doc_selection',
    ...(blockIds.length > 0 ? { blockIds } : {}),
    ...(fullText.trim() ? { fullText } : {}),
  })

  deps.expandCanvasForScope(targetTabScopeKey)
  const frontendType = contextRegistry.normalizeBackendType('tabdoc')
  const dispatched = contextRegistry.dispatchSelect(
    { type: frontendType, id: docId, tabKey: `${frontendType}:${docId}` as `${string}:${string}`, title: '', meta: { spaceId } },
    { spaceId, tabScopeKey: targetTabScopeKey, closeBrowserView: () => {} },
  )
  if (!dispatched) {
    const { openResourceTabGuarded } = await import(
      '@components/context-space/restore/openResourceMembershipGuard'
    )
    openResourceTabGuarded(targetTabScopeKey, {
      type: frontendType,
      id: docId,
      title: block.preview?.split('\n')[0] || '',
      meta: { spaceId },
    }, spaceId)
  }
}

async function navigateGenericResourceBlock(
  block: ContextBlock,
  spaceId: string,
  targetTabScopeKey: string,
  deps: ContextBlockNavigationDeps,
): Promise<void> {
  const resourceId = block.table_id || block.doc_id || block.field_id
  if (!resourceId) return

  const type = block.type === 'table_selection' || block.type === 'table' ? 'tabdata'
    : block.type === 'doc_selection' || block.type === 'document' ? 'tabdoc'
    : block.type || ''
  const { contextRegistry } = await import('@components/context-space/registry')
  const { useSpaceContextTabsStore } = await import('@/stores/useSpaceContextTabsStore')

  if (type === 'tabdata') {
    deps.expandCanvasForScope(targetTabScopeKey)
    useSpaceContextTabsStore.getState().openTableTab(targetTabScopeKey, resourceId)
    return
  }

  const frontendType = contextRegistry.normalizeBackendType(type)
  deps.expandCanvasForScope(targetTabScopeKey)
  const dispatched = contextRegistry.dispatchSelect(
    { type: frontendType, id: resourceId, tabKey: `${frontendType}:${resourceId}` as `${string}:${string}`, title: '', meta: { spaceId } },
    { spaceId, tabScopeKey: targetTabScopeKey, closeBrowserView: () => {} },
  )
  if (!dispatched) {
    if (frontendType === 'tabdoc') {
      const { openResourceTabGuarded } = await import(
        '@components/context-space/restore/openResourceMembershipGuard'
      )
      openResourceTabGuarded(targetTabScopeKey, {
        type: frontendType,
        id: resourceId,
        title: block.preview?.split('\n')[0] || '',
        meta: { spaceId },
      }, spaceId)
      return
    }
    useSpaceContextTabsStore.getState().openResourceTab(targetTabScopeKey, {
      type: frontendType,
      id: resourceId,
      title: block.preview?.split('\n')[0] || '',
    })
  }
}

export async function navigateContextBlock(
  params: ContextBlockNavigationParams,
  deps: ContextBlockNavigationDeps,
): Promise<void> {
  const context = resolveNavigationContext(params)
  if (!context) {
    deps.warn('[ChatPanel] context block navigate skipped: no space context', params.block)
    deps.toastNoSpace()
    return
  }

  const { block } = params
  const { spaceId, targetTabScopeKey } = context

  if (block.resource_id && block.type) {
    try {
      const { openProjectTaskDocumentPreview } = await import('@/services/openProjectTaskDocumentPreview')
      if (openProjectTaskDocumentPreview({
        resourceType: block.type,
        resourceId: block.resource_id,
        tabScopeKey: params.tabScopeKey,
        ...(block.space_id ? { resourceSpaceId: block.space_id } : {}),
      })) {
        return
      }
      await navigateRichResourceBlock(block, spaceId, targetTabScopeKey, deps)
    } catch (err) {
      deps.warn('[ChatPanel] resource router navigate failed:', err)
      deps.toastOpenFailed(err instanceof Error ? err.message : String(err))
    }
    return
  }

  try {
    const { ensureSpaceSelectedWithFeedback } = await import('@/services/spaceNavigation')
    const didSelect = await ensureSpaceSelectedWithFeedback(spaceId, {})
    if (!didSelect) return

    if (block.type === 'code_file' || block.type === 'code_selection') {
      await navigateCodeContextBlock(block, spaceId, targetTabScopeKey, deps)
      return
    }

    if (isWebContextRefBlock(block)) {
      await navigateWebContextBlock(block, spaceId, targetTabScopeKey, deps)
      return
    }

    if (block.type === 'doc_selection' || block.type === 'document') {
      await navigateDocContextBlock(block, spaceId, targetTabScopeKey, deps)
      return
    }

    await navigateGenericResourceBlock(block, spaceId, targetTabScopeKey, deps)
  } catch (err) {
    deps.warn('[ChatPanel] context block navigate failed:', err)
    deps.toastOpenFailed(err instanceof Error ? err.message : String(err))
  }
}
