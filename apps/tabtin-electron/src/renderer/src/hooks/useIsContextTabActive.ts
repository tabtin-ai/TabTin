import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('ContextTabActive')

/**
 * 判断 context tab 是否应被视为激活（允许 TablePane 初始化）。
 *
 * TablePane runtime 按 tableId 全局唯一：同一 tabKey 若在任一 scope 桶内为
 * activeKey，即允许初始化——避免 legacy / desktop / conversation 多桶
 * last-write-wins 把可见前景 tab 误判为 inactive。
 *
 * 标签桶 key 可能是 `conversation:*` / `desktop:*` 等 scope，不等于 SpaceList 的 spaceId。
 * 若误用 spaceId 查 activeKeyBySpace，scope 模式下 isActive 恒为 false，TabData 会卡在
 * 「正在准备表格内容…」且 initializeView 永不执行。
 */
export function useIsContextTabActive(tabKey: string | null | undefined): boolean {
  return useSpaceContextTabsStore((state) => {
    if (!tabKey) return true

    for (const activeKey of Object.values(state.activeKeyBySpace)) {
      if (activeKey === tabKey) {
        return true
      }
    }

    const scopeKey = state.findSpaceByTabKey(tabKey)
    if (!scopeKey) return true

    const isActive = state.activeKeyBySpace[scopeKey] === tabKey
    if (!isActive) {
      log.debug('tab inactive in resolved scope', {
        tabKey,
        scopeKey,
        activeKey: state.activeKeyBySpace[scopeKey] ?? null,
      })
    }
    return isActive
  })
}

/**
 * 解析 tabKey 所在的 scope 桶 key（与 openTableTab / openResourceTab 写入口径一致）。
 * 重复 tabKey 时走 store 的确定性 resolver（active → display → desktop 优先）。
 */
export function useContextTabScopeKey(tabKey: string | null | undefined): string | null {
  return useSpaceContextTabsStore((state) => {
    if (!tabKey) return null
    return state.findSpaceByTabKey(tabKey)
  })
}
