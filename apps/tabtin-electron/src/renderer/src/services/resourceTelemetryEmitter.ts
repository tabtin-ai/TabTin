/**
 * resourceTelemetryEmitter — Wave 7 renderer 侧 emitEvent 接通点。
 *
 * 通路（RFC §8.3）：
 *   ResourceRouter.emitEvent(event)
 *     → createResourceTelemetryEmitter() 返回的函数
 *     → 从 useAuthStore + useOrganizationStore 注入 user_id / organization_id
 *     → window.tabtin.resourceTelemetry.emit(event)（preload IPC）
 *     → main 进程 telemetry queue + 5s flush + HTTP POST + 重试 + 死信
 *
 * 设计取向：
 *
 * 1. **失败永远不能阻塞 UI**（W7 红线）：preload IPC `invoke` 是 Promise，
 *    我们 fire-and-forget 不 await，并把任何同步 throw catch 掉。
 *
 * 2. **user_id / organization_id 在 renderer 端注入而不是 main / Django 端**：
 *    - main 进程 TokenManager 只有 access_token，不直接持有 user_id；
 *      解 JWT 拿 sub 字段需要复制 jose 解析逻辑（main 已有但要绕一圈）
 *    - Django 端 user_id 由 jwt_auth 自动覆盖（信任服务端比客户端更可靠），
 *      但 organization_id 没有"选中态"概念在服务端——只有 renderer 有 zustand
 *      store 知道当前选中哪个 organization
 *    - 所以在 renderer 端补全是最完整的策略；服务端会再用 jwt_auth 校正
 *      user_id（双重保险）
 *
 * 3. **W7 北极星 #5 `SELECT DISTINCT resolve_source`**：renderer 端不丢任何
 *    event（不按 resolve_source 过滤），让 W8 验收能看到 6 个 distinct 值。
 *
 * 4. **未登录态**：用户未登录时 router 一般不会被触发（chat/settings 都
 *    要登录），但保险起见若 user.id 为空则跳过 emit——避免污染表结构
 *    （PG UUIDField 不接受空字符串）。该场景属于"匿名 chat preview"等
 *    边角情况，本期不上报；W8 验收 SQL 排查时不会看到孤立 user_id=''。
 */

import type { ResourceOpenEvent } from '@tabtin/resource-router'
import { useAuthStore } from '@/stores/useAuthStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { logger } from '@/utils/logger'

/**
 * preload `tabtin.resourceTelemetry.emit` 的最小调用接口（避免 import
 * 整个 TabTinAPI 类型增加耦合面；只断言我们要的字段存在）。
 */
type ResourceTelemetryWindow = {
  resourceTelemetry?: {
    emit?: (event: ResourceOpenEvent) => Promise<{ ok: boolean }> | void
  }
}

function getEmitFn(): ResourceTelemetryWindow['resourceTelemetry'] | undefined {
  if (typeof window === 'undefined') return undefined
  const tabtin = (window as unknown as { tabtin?: ResourceTelemetryWindow }).tabtin
  return tabtin?.resourceTelemetry
}

/**
 * 在事件中注入 user_id / organization_id（仅当 router emit 时这两个字段是空字符串）。
 *
 * 不覆写 router 已经填好的值——若 OpenOptions 显式传入了 userId/organizationId
 * （未来 daemon 端 / 单测 fixture 等场景），保留调用方意图。
 */
function injectAuthContext(event: ResourceOpenEvent): ResourceOpenEvent {
  const next: ResourceOpenEvent = { ...event }
  if (!next.user_id) {
    const user = useAuthStore.getState().user
    if (user?.id != null) next.user_id = String(user.id)
  }
  if (!next.organization_id) {
    const wt = useOrganizationStore.getState().selectedOrganization
    if (wt?.id) next.organization_id = String(wt.id)
  }
  return next
}

/**
 * 创建一个供 wireResourceRouter 注入的 emitEvent 函数。
 *
 * 调用约定（与 ResourceRouter.emitEvent 同步）：
 *   - 永不抛
 *   - 不返回 Promise（router 不 await emit）
 *   - 失败只在 dev 环境 logger.warn，不影响调用链路
 */
export function createResourceTelemetryEmitter(): (event: ResourceOpenEvent) => void {
  return (event) => {
    try {
      const emitter = getEmitFn()
      if (!emitter?.emit) return // preload 未加载（test / detached window）
      const enriched = injectAuthContext(event)
      // user_id / organization_id 仍然空 → 跳过（PG UUIDField 不允许空）
      if (!enriched.user_id || !enriched.organization_id) {
        logger.debug('[resourceTelemetry] skip emit: missing user_id or organization_id', {
          event_name: enriched.event_name,
          trigger_source: enriched.trigger_source,
        })
        return
      }
      const result = emitter.emit(enriched)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        ;(result as Promise<unknown>).catch((err) => {
          logger.warn('[resourceTelemetry] emit IPC rejected (non-fatal)', err)
        })
      }
    } catch (err) {
      logger.warn('[resourceTelemetry] emit threw synchronously (non-fatal)', err)
    }
  }
}
