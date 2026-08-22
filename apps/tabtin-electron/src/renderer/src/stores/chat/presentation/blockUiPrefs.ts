/**
 * 聊天块折叠/展开 UI 偏好 store。
 *
 * 为什么需要它：聊天块的折叠/展开态原本是各卡组件的本地 `useState`，一旦组件
 * remount 就归零。而消息列表用虚拟化——流式贴底时前面消息会滚出视口被 TanStack
 * Virtual **unmount**、滚回再 **remount**，导致「后续消息刷新后前面消息的展开态丢失」。
 *
 * 折叠/展开是「用户对某个块身份的偏好」，不该绑死在组件实例上。这里把它按 block
 * 身份（block_id / 折叠组首 block_id）存进一个进程内 store，任何 remount/虚拟化回收
 * 后按 key 读回，展开态得以跨 remount 存活。
 *
 * 作用域：进程内内存即可（折叠属会话内短期偏好，不做持久化）；key 用全局唯一的
 * block_id，天然按会话隔离，无需再拼 sessionId。
 */
import { create } from 'zustand'
import { useCallback, useState } from 'react'

interface BlockUiPrefsState {
  expandedByKey: Record<string, boolean>
  setExpanded: (key: string, expanded: boolean) => void
}

export const useChatBlockUiPrefsStore = create<BlockUiPrefsState>((set) => ({
  expandedByKey: {},
  setExpanded: (key, expanded) =>
    set((s) =>
      s.expandedByKey[key] === expanded
        ? s
        : { expandedByKey: { ...s.expandedByKey, [key]: expanded } },
    ),
}))

/** 折叠组 key（与 CollapsibleToolCardGroup 的 react key 对齐）。 */
export function groupExpandKey(firstBlockId: string): string {
  return `group:${firstBlockId}`
}

/** 单块（工具卡 / 思考块）key。 */
export function blockExpandKey(blockId: string): string {
  return `block:${blockId}`
}

/**
 * 跨 remount 存活的展开态 hook：按 key 从 store 读回，缺省用 `defaultExpanded`。
 * key 为 null 时退化为组件本地 `useState`（standalone 仍可切换，只是不跨 remount 持久）。
 */
export function useBlockExpanded(
  key: string | null,
  defaultExpanded: boolean,
): [boolean, (expanded: boolean) => void] {
  const stored = useChatBlockUiPrefsStore((s) => (key != null ? s.expandedByKey[key] : undefined))
  const storeSet = useChatBlockUiPrefsStore((s) => s.setExpanded)
  const [local, setLocal] = useState(defaultExpanded)
  const expanded = key != null ? (stored ?? defaultExpanded) : local
  const setExpanded = useCallback(
    (next: boolean) => {
      if (key != null) storeSet(key, next)
      else setLocal(next)
    },
    [key, storeSet],
  )
  return [expanded, setExpanded]
}
