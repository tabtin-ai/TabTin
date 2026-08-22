/**
 * planExecutedStore — plan「已执行」状态的本地持久化
 *
 * plan 卡片改成持久化 block（tabtin_rich_content kind='plan'）后，block payload 里的
 * `executed` 始终是 runtime 侧的初始值（false）——客户端无法回写服务端 block。为了让
 * 「已点执行」在**重启后仍保留**（按钮 disabled、显示已执行），用 localStorage 按
 * `plan_ref` key 记录已执行集合。与 block.executed 做「或」。
 */

const STORAGE_KEY = 'tabtin:plan-executed:v1'

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function isPlanExecuted(planRefKey: string): boolean {
  if (!planRefKey) return false
  return read().has(planRefKey)
}

export function markPlanExecuted(planRefKey: string): void {
  if (!planRefKey) return
  const set = read()
  if (set.has(planRefKey)) return
  set.add(planRefKey)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]))
  } catch {
    // 存储失败（隐私模式/配额）不阻断执行——最坏是重启后按钮回到可点态。
  }
}
