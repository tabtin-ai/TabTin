/**
 * 启动时保守清理历史 TabDoc 双桶。
 *
 * winner 顺序（禁止硬编码 cloud-docs > im）：
 * 1. 唯一 active scope（activeKey === tabKey）
 * 2. 当前 foreground workspaceContext.key（若命中该 tab）
 * 3. 唯一导航意图指向该 tab 的 scope
 * 仍歧义或 dirty → 跳过并打诊断日志，不静默删除。
 */

import {
  getNavigationIntent,
  useSpaceContextTabsStore,
} from '@stores/useSpaceContextTabsStore'
import { createLogger } from '@/utils/logger'
import { parseTabKey } from '@stores/contextTabs/helpers'
import {
  getTabDocDirtySnapshot,
  shouldConfirmTabDocClose,
} from './tabdocDirtyRegistry'
import { listScopesForTabKey, migrateTabKeyToScope } from './tabdocScopeClaim'

const log = createLogger('TabDocScopeDedupe')

export type TabDocDedupeSkip = {
  tabKey: string
  reason: 'dirty' | 'ambiguous' | 'no-winner'
  scopes: string[]
}

export type TabDocDedupeResult = {
  deduped: Array<{ tabKey: string; winner: string; closed: string[] }>
  skipped: TabDocDedupeSkip[]
}

function collectTabDocKeys(
  tabOrderBySpace: Record<string, string[]>,
  itemsBySpace: Record<string, Record<string, unknown>>,
): string[] {
  const keys = new Set<string>()
  for (const order of Object.values(tabOrderBySpace)) {
    for (const key of order ?? []) {
      if (key.startsWith('tabdoc:')) keys.add(key)
    }
  }
  for (const items of Object.values(itemsBySpace)) {
    for (const key of Object.keys(items ?? {})) {
      if (key.startsWith('tabdoc:')) keys.add(key)
    }
  }
  return [...keys]
}

function resolveDedupeWinner(
  tabKey: string,
  scopes: string[],
  foregroundScopeKey: string | null,
  activeKeyBySpace: Record<string, string | null | undefined>,
): string | null {
  const activeScopes = scopes.filter(scope => activeKeyBySpace[scope] === tabKey)
  if (activeScopes.length === 1) return activeScopes[0]
  if (activeScopes.length > 1) {
    // 多个桶同时 active：仅当 foreground 落在其中时才能裁决
    if (foregroundScopeKey && activeScopes.includes(foregroundScopeKey)) {
      return foregroundScopeKey
    }
    return null
  }

  if (foregroundScopeKey && scopes.includes(foregroundScopeKey)) {
    return foregroundScopeKey
  }

  const intentScopes = scopes.filter((scope) => {
    const intent = getNavigationIntent(scope)
    return intent?.targetKey === tabKey
  })
  if (intentScopes.length === 1) return intentScopes[0]

  return null
}

/**
 * 对持久化多桶 TabDoc 做一次保守 dedupe。可重复调用；无多桶时为 no-op。
 */
export function dedupePersistedTabDocScopes(options: {
  foregroundScopeKey: string | null
}): TabDocDedupeResult {
  const tabs = useSpaceContextTabsStore.getState()
  const tabKeys = collectTabDocKeys(tabs.tabOrderBySpace, tabs.itemsBySpace)
  const deduped: TabDocDedupeResult['deduped'] = []
  const skipped: TabDocDedupeSkip[] = []

  for (const tabKey of tabKeys) {
    const scopes = listScopesForTabKey(tabKey, tabs)
    if (scopes.length <= 1) continue

    const parsed = parseTabKey(tabKey)
    const documentId = parsed?.type === 'tabdoc' ? parsed.id : null
    const snapshot = documentId ? getTabDocDirtySnapshot(documentId) : null
    if (shouldConfirmTabDocClose(snapshot)) {
      skipped.push({ tabKey, reason: 'dirty', scopes })
      log.warn('skip tabdoc dedupe: dirty', { tabKey, scopes })
      continue
    }

    const winner = resolveDedupeWinner(
      tabKey,
      scopes,
      options.foregroundScopeKey,
      tabs.activeKeyBySpace,
    )
    if (!winner) {
      skipped.push({
        tabKey,
        reason: scopes.filter(s => tabs.activeKeyBySpace[s] === tabKey).length > 1
          ? 'ambiguous'
          : 'no-winner',
        scopes,
      })
      log.warn('skip tabdoc dedupe: no safe winner', {
        tabKey,
        scopes,
        foregroundScopeKey: options.foregroundScopeKey,
      })
      continue
    }

    const closed = migrateTabKeyToScope(tabKey, winner)
    if (closed.length > 0) {
      deduped.push({ tabKey, winner, closed })
      log.info('deduped persisted tabdoc scopes', { tabKey, winner, closed })
    }
  }

  return { deduped, skipped }
}
