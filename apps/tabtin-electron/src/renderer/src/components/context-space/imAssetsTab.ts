/**
 * IM 会话资产 tab 的共享常量与 id 编码——rail 入口、context handler、清理逻辑共用，
 * 避免 'imassets' 魔法串和 id 格式在多处漂移。
 */
export const IM_ASSETS_TAB_TYPE = 'imassets'

export type ImAssetKind = 'document' | 'file' | 'shared_session'

/** id 形态：`${kind}:${conversationId}`（conversationId 为无冒号 UUID）。 */
export function buildImAssetsId(kind: ImAssetKind, conversationId: string): string {
  return `${kind}:${conversationId}`
}

/**
 * 从 imassets tab 的 id 解析出 kind + conversationId。
 * tabKey=`imassets:${kind}:${conversationId}` 经 parseTabKey（按首冒号切）后 id 保留 `${kind}:${conversationId}`。
 */
export function parseImAssetsId(id: string): { kind: ImAssetKind; conversationId: string } | null {
  const idx = id.indexOf(':')
  if (idx <= 0) return null
  const kind = id.slice(0, idx)
  const conversationId = id.slice(idx + 1)
  if ((kind !== 'document' && kind !== 'file' && kind !== 'shared_session') || !conversationId) {
    return null
  }
  return { kind, conversationId }
}
