/**
 * 组织生命周期事件总线
 *
 * 零 store 依赖，任何模块可安全导入。
 */

type OrganizationSelectedListener = (organizationId: string) => void

const listeners = new Set<OrganizationSelectedListener>()

export function onOrganizationSelected(listener: OrganizationSelectedListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitOrganizationSelected(organizationId: string): void {
  listeners.forEach(fn => {
    try { fn(organizationId) } catch { /* 防止单个 listener 异常阻塞其他 */ }
  })
}
