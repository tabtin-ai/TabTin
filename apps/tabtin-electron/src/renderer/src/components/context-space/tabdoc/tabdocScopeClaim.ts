/**
 * TabDoc 单 scope 收口
 *
 * 打开意图处保证同一 `tabdoc:{id}` 只留在调用方显式给出的 targetScope。
 * dirty 时复用关闭确认三态：保存 / 放弃 / 取消；取消或保存失败不改任何桶。
 * foreign scope 用普通 `closeTab`（不 bump explicitCloseRevision）。
 */

import { toast } from '@tabtin/smartsheet-ui'
import i18n from '@/i18n'
import { parseTabKey } from '@stores/contextTabs/helpers'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { createLogger } from '@/utils/logger'
import { requestTabDocCloseConfirm } from './tabdocCloseConfirm'
import {
  getTabDocDirtySnapshot,
  saveTabDoc,
  shouldConfirmTabDocClose,
} from './tabdocDirtyRegistry'

const log = createLogger('TabDocScopeClaim')

export type ClaimTabDocScopeResult = 'claimed' | 'cancelled' | 'noop'

/** 收集已挂载该 tabKey 的 scope（order / items / active 任一命中）。 */
export function listScopesForTabKey(
  tabKey: string,
  state: {
    tabOrderBySpace?: Record<string, string[]>
    itemsBySpace?: Record<string, Record<string, unknown>>
    activeKeyBySpace?: Record<string, string | null | undefined>
  },
): string[] {
  const scopes = new Set<string>()
  // Store 恢复前和测试中的轻量 state 可能尚未初始化这些桶；此时没有可迁移
  // 的旧 Tab，按空映射处理，让通知深链仍能直接打开目标文档。
  for (const [scopeKey, order] of Object.entries(state.tabOrderBySpace ?? {})) {
    if (order?.includes(tabKey)) scopes.add(scopeKey)
  }
  for (const [scopeKey, items] of Object.entries(state.itemsBySpace ?? {})) {
    if (items && tabKey in items) scopes.add(scopeKey)
  }
  for (const [scopeKey, active] of Object.entries(state.activeKeyBySpace ?? {})) {
    if (active === tabKey) scopes.add(scopeKey)
  }
  return [...scopes]
}

/**
 * 无确认地保证 tabKey 只留在 targetScope（clean 路径 / 已确认后）。
 * 返回被关闭的 foreign scopes。
 */
export function migrateTabKeyToScope(tabKey: string, targetScope: string): string[] {
  const tabs = useSpaceContextTabsStore.getState()
  const foreignScopes = listScopesForTabKey(tabKey, tabs).filter(scope => scope !== targetScope)
  for (const scope of foreignScopes) {
    tabs.closeTab(scope, tabKey, null)
  }
  return foreignScopes
}

function documentIdFromTabKey(tabKey: string): string | null {
  const parsed = parseTabKey(tabKey)
  if (!parsed || parsed.type !== 'tabdoc' || !parsed.id) return null
  return parsed.id
}

/**
 * dirty-aware 单 scope claim。
 * - 无 foreign → noop
 * - clean → 直接 migrate → claimed
 * - dirty cancel / save 失败 → cancelled（不改桶）
 * - dirty discard / save 成功 → migrate → claimed
 */
export async function claimTabDocScope(
  tabKey: string,
  targetScope: string,
  options?: { displayName?: string },
): Promise<ClaimTabDocScopeResult> {
  const tabs = useSpaceContextTabsStore.getState()
  const foreignScopes = listScopesForTabKey(tabKey, tabs).filter(scope => scope !== targetScope)
  if (foreignScopes.length === 0) return 'noop'

  const documentId = documentIdFromTabKey(tabKey)
  const snapshot = documentId ? getTabDocDirtySnapshot(documentId) : null

  if (!shouldConfirmTabDocClose(snapshot)) {
    const closed = migrateTabKeyToScope(tabKey, targetScope)
    log.info('claimed clean tabdoc scope', { tabKey, targetScope, closed })
    return 'claimed'
  }

  const displayName = options?.displayName || snapshot?.title || documentId || tabKey
  const choice = await requestTabDocCloseConfirm(displayName)
  if (choice === 'cancel') {
    log.info('scope claim cancelled by user', { tabKey, targetScope, foreignScopes })
    return 'cancelled'
  }
  if (choice === 'save') {
    if (!documentId) {
      log.warn('scope claim save skipped: missing documentId', { tabKey })
      return 'cancelled'
    }
    const ok = await saveTabDoc(documentId)
    if (!ok) {
      toast({
        title: i18n.t('tabdoc:closeConfirm.saveFailedTitle', { defaultValue: '保存失败' }),
        description: i18n.t('tabdoc:closeConfirm.saveFailedDesc', {
          defaultValue: '文档未能保存到服务器，标签已保留。请检查网络后重试，或选择"放弃修改"关闭。',
        }),
        variant: 'destructive',
      })
      return 'cancelled'
    }
  }

  const closed = migrateTabKeyToScope(tabKey, targetScope)
  log.info('claimed dirty tabdoc scope', { tabKey, targetScope, closed, choice })
  return 'claimed'
}

/**
 * 仅在 clean 时可同步 claim；dirty 返回 needs-confirm，调用方再走 async 确认。
 * 用于保持多数打开路径的同步语义（测试 / 无 UI 阻塞）。
 */
export function tryClaimTabDocScopeSync(
  tabKey: string,
  targetScope: string,
): 'claimed' | 'noop' | 'needs-confirm' {
  const tabs = useSpaceContextTabsStore.getState()
  const foreignScopes = listScopesForTabKey(tabKey, tabs).filter(scope => scope !== targetScope)
  if (foreignScopes.length === 0) return 'noop'

  const documentId = documentIdFromTabKey(tabKey)
  const snapshot = documentId ? getTabDocDirtySnapshot(documentId) : null
  if (shouldConfirmTabDocClose(snapshot)) {
    return 'needs-confirm'
  }
  const closed = migrateTabKeyToScope(tabKey, targetScope)
  log.info('claimed clean tabdoc scope (sync)', { tabKey, targetScope, closed })
  return 'claimed'
}
