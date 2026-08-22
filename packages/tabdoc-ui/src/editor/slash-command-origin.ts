import { isChangeOrigin } from '@tiptap/extension-collaboration'
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'

/**
 * 记录当前 transaction 是否来自 Yjs→PM 同步。
 * 必须排在 slash suggestion 插件之前，以便 `allow` 能读到本轮结果。
 */
export const slashRemoteOriginPluginKey = new PluginKey<boolean>('tabdocSlashRemoteOrigin')

/**
 * 协作远端同步的 `/` 不应新开本机 slash 菜单；
 * 本机已打开的菜单在仍匹配时，不因无关远端编辑被强制关闭。
 */
export function shouldAllowSlashSuggestion(input: {
  isRemoteOrigin: boolean
  isActive?: boolean
}): boolean {
  if (input.isRemoteOrigin && !input.isActive) return false
  return true
}

export function createSlashRemoteOriginGate() {
  const gate = { isRemoteOrigin: false }
  const plugin = new Plugin({
    key: slashRemoteOriginPluginKey,
    apply(transaction: Transaction) {
      gate.isRemoteOrigin = isChangeOrigin(transaction)
      return gate.isRemoteOrigin
    },
  })
  return { gate, plugin }
}
