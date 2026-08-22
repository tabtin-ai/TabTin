/**
 * tabdoc 类型的 DirtyResourceProvider —— 把 tabdocDirtyRegistry 桥接到通用聚合层。
 *
 * 在 registry/index.ts 启动时调用 `installTabdocDirtyProvider()` 注册一次（幂等）。
 * 这样 ⌘Q / 关 Space 路径就能通过 collectAllDirty(spaceId?) 拿到 tabdoc 的 dirty 列表。
 */
import { collectAllDirty as collectTabDocDirty, saveTabDoc } from './tabdocDirtyRegistry'
import { registerDirtyProvider } from '../dirtyRegistry'
import type { DirtyResource, DirtyResourceProvider } from '../dirtyRegistry'

const TABDOC_TYPE = 'tabdoc'

const provider: DirtyResourceProvider = {
  type: TABDOC_TYPE,
  collect: (spaceId): DirtyResource[] => {
    const items = collectTabDocDirty(spaceId)
    return items.map((entry) => ({
      type: TABDOC_TYPE,
      id: entry.documentId,
      spaceId: entry.spaceId,
      title: entry.title,
    }))
  },
  save: (id) => saveTabDoc(id),
}

let installed = false

/**
 * 幂等地把 tabdoc 接入聚合层。registry/index.ts 启动时调用一次即可。
 * 测试场景下可通过 _resetDirtyRegistry + 再次调用本函数复现真实接入。
 */
export function installTabdocDirtyProvider(): () => void {
  if (installed) {
    return () => {}
  }
  installed = true
  const unregister = registerDirtyProvider(provider)
  return () => {
    installed = false
    unregister()
  }
}

/** 测试用 —— 重置 install 状态 */
export function _resetTabdocDirtyProviderInstallFlag(): void {
  installed = false
}
