/**
 * activityRailOrder — ActivityRail 五大域的用户自定义排序。
 *
 * 存储语义：`useSpaceViewPrefsStore.activityRailDomainOrder` 保存**全量域顺序**
 * （含当前不可见域，如 Projects 开关关闭时的 projects），读取时按可见集归一化：
 *   - stored 中可见的域 → 按 stored 顺序排列；
 *   - 可见但 stored 缺失的域（新上线的域 / 从未拖过）→ 按默认顺序追加末尾；
 *   - stored 中已下线或非法的 id → 丢弃。
 * 这样域集合未来增删都不需要数据 migration，顺序偏好也不会丢。
 *
 * 拖拽落笔时把「可见子集的重排结果」归并回全量顺序（mergeRailDomainOrder），
 * 不可见域的相对槽位原样保留，开关再次打开后位置不漂移。
 */

export type ActivityRailDomainId = 'tasks' | 'messages' | 'agents' | 'cloud-docs' | 'projects'

/** 默认域顺序，与 ActivityRail 的 DOMAIN_NAV_ITEMS 声明顺序保持一致（测试钉住）。 */
export const DEFAULT_ACTIVITY_RAIL_DOMAIN_ORDER: readonly ActivityRailDomainId[] = [
  'tasks',
  'messages',
  'agents',
  'cloud-docs',
  'projects',
]

export function isActivityRailDomainId(value: unknown): value is ActivityRailDomainId {
  return (
    value === 'tasks'
    || value === 'messages'
    || value === 'agents'
    || value === 'cloud-docs'
    || value === 'projects'
  )
}

/**
 * 归一化出当前应展示的域顺序：stored 顺序 ∩ 可见集在前，可见但未被 stored
 * 覆盖的域按默认顺序追加末尾。
 */
export function resolveRailDomainOrder(input: {
  visibleIds: readonly ActivityRailDomainId[]
  storedOrder?: readonly string[] | null
}): ActivityRailDomainId[] {
  const { visibleIds, storedOrder } = input
  if (!storedOrder || storedOrder.length === 0) return [...visibleIds]

  const visibleSet = new Set<ActivityRailDomainId>(visibleIds)
  const seen = new Set<ActivityRailDomainId>()
  const ordered: ActivityRailDomainId[] = []

  for (const id of storedOrder) {
    if (!isActivityRailDomainId(id) || seen.has(id) || !visibleSet.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  for (const id of visibleIds) {
    if (!seen.has(id)) ordered.push(id)
  }
  return ordered
}

/**
 * 把可见子集的重排结果归并回全量顺序：全量顺序中属于可见集的槽位按
 * reorderedVisibleIds 依次填充，不可见域留在原槽位。
 * 调用契约：reorderedVisibleIds 必须是 fullOrder ∩ 可见集 的一个排列。
 */
export function mergeRailDomainOrder(input: {
  fullOrder: readonly ActivityRailDomainId[]
  reorderedVisibleIds: readonly ActivityRailDomainId[]
}): ActivityRailDomainId[] {
  const { fullOrder, reorderedVisibleIds } = input
  const visibleSet = new Set<ActivityRailDomainId>(reorderedVisibleIds)
  const queue = [...reorderedVisibleIds]
  return fullOrder.map(id => (visibleSet.has(id) ? queue.shift() ?? id : id))
}
