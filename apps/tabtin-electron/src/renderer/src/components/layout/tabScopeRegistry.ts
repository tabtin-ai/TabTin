/**
 * Tab scope registry — 持久化分桶前缀与白名单（P0 收口 cloud-docs 等域）。
 */
import { isCloudDocsScopeKey } from './cloudDocsDomain'
import {
  isConversationScopeKey,
  isDesktopScopeKey,
  isImConversationScopeKey,
} from './workspaceContextState'

/** localStorage 中按 scope key 分桶、purge 时需保留的非裸 UUID 前缀。 */
export function isPersistedWorkspaceScopeKey(key: string): boolean {
  return (
    isDesktopScopeKey(key)
    || isConversationScopeKey(key)
    || isImConversationScopeKey(key)
    || isCloudDocsScopeKey(key)
  )
}
