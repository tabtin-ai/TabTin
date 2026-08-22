/**
 * Store 初始化 — 连接 useOrganizationStore ↔ useSpaceStore 之间的循环依赖
 *
 * 各平台在 configureAppShell() 之后调用 initAppShellStores() 即可。
 */

import {
  setCurrentSpaceOrganizationIdResolver,
  setSpaceClearer,
} from './use-organization-store.js'
import { useSpaceStore } from './use-space-store.js'

let _initialized = false

export function initAppShellStores(): void {
  if (_initialized) return
  _initialized = true
  setSpaceClearer(() => useSpaceStore.getState().clearSpaces())
  setCurrentSpaceOrganizationIdResolver(
    () => useSpaceStore.getState().selectedSpace?.organization_id ?? null,
  )
}
