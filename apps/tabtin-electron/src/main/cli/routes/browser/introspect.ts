/**
 * 浏览器自描述路由（BR-5 / BR-6）—— Electron 端。
 *
 * 两个只读出口，纯只读、零风险、不动现有 route 行为：
 *   - `/context`      ：当前 runtime + 活跃 tab + crawlspace/workspace + source。
 *                       从 `CrawlspaceContextHub`（面向渲染进程的唯一状态源）取活跃 tab。
 *   - `/capabilities` ：读共享能力矩阵，**只投影 electron 那一列**返回
 *                       （双端同源投影 → 永不漂移）。
 *
 * 这两条不依赖 action executor / View bridge，所以在 dispatcher 里放在 executor 闸门**之前**，
 * 即使前端尚未就绪也能回答「我是谁、能干什么」。
 *
 * BR-8 P1：响应拼装下沉到 `@tabtin/browser-core` 的契约驱动 Orchestrator
 * （`handleBrowserAction`），本文件只剩「取本端 hostHooks → 调 Orchestrator → 用本端
 * okResponse 落地」。**行为/输出与迁移前逐字段一致**（纯结构搬迁，零行为变更）：
 * Electron 这一端的「最后一公里」——活跃 tab、source、space/crawlspace/workspace——
 * 经 `getElectronContextInfo()` 注入。
 */

import http from 'node:http'
import { app } from 'electron'
import { okResponse } from '@tabtin/agent-wire'
import {
  handleBrowserAction,
  type BrowserContextInfo,
  type BrowserOrchestratorHostHooks,
} from '@tabtin/browser-core'
import type { SendJSON } from './_helpers'
import { electronPolicyHooks } from './_helpers'
import { getCLISpaceId, getCLICrawlspaceId, getCLIOrganizationRoot } from '../../cli-context'
import { getCrawlspaceContextHub } from '../../../crawlspace/CrawlspaceContextHub'

type ActiveTab = { id: string; url: string | null; title: string | null }

/**
 * 从 CrawlspaceContextHub 解析当前活跃 tab + 可见 tab 数。
 * 无 crawlspace / 无活跃可见 View 时返回 { activeTab: null, tabCount: 0 }。
 */
function resolveContextFromHub(crawlspaceId: string | null): { activeTab: ActiveTab | null; tabCount: number } {
  if (!crawlspaceId) return { activeTab: null, tabCount: 0 }
  try {
    const snapshot = getCrawlspaceContextHub().getSnapshot(crawlspaceId)
    const views = Array.isArray(snapshot?.views)
      ? snapshot.views.filter((view) => !view.isClosing)
      : []
    const active = snapshot?.activeViewId
      ? views.find((view) => view.viewId === snapshot.activeViewId)
      : undefined
    const activeTab: ActiveTab | null = active
      ? { id: active.viewId, url: active.url ?? null, title: active.title ?? null }
      : null
    return { activeTab, tabCount: views.length }
  } catch {
    return { activeTab: null, tabCount: 0 }
  }
}

/**
 * Electron 端 `context` 的「最后一公里」：从 CrawlspaceContextHub 取活跃 tab / tabCount，
 * 从 CLI 上下文取 space / crawlspace / workspace，source 按是否打包区分。
 * `runtime` 由 Orchestrator 经 hostHooks.runtime 统一拼，这里不重复。
 */
function getElectronContextInfo(): BrowserContextInfo {
  const crawlspaceId = getCLICrawlspaceId()
  const { activeTab, tabCount } = resolveContextFromHub(crawlspaceId)
  return {
    source: app.isPackaged ? 'electron' : 'electron-dev',
    spaceId: getCLISpaceId() ?? null,
    crawlspaceId: crawlspaceId ?? null,
    workspaceRoot: getCLIOrganizationRoot() ?? null,
    activeTab,
    tabCount,
  }
}

/** Electron 端注入 Orchestrator 的宿主钩子。 */
const electronHostHooks: BrowserOrchestratorHostHooks = {
  runtime: 'electron',
  getContextInfo: getElectronContextInfo,
  // BR-9：context/capabilities 是 read→allow、不会触发 confirm；注入 policy 仅为统一闸门
  // 形态、并为将来此处接入写类自描述命令兜底（缺 policy 时 confirm 会 fail-closed 被拒）。
  policy: electronPolicyHooks,
}

/**
 * 处理自描述路由。命中 `/context` 或 `/capabilities` 返回 true（已消费），否则 false。
 */
export async function handleIntrospectRoute(
  route: string,
  body: unknown,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<boolean> {
  if (route === '/context' || route === '/capabilities') {
    const actionId = route === '/context' ? 'context' : 'capabilities'
    const result = await handleBrowserAction(actionId, body, electronHostHooks)
    // 自描述命令恒成功（ok:true）；保留 error 分支只为类型完备，实际不会命中。
    // 三元联合（含 electron-executor 变体）下须先 `'ok' in result` 收窄再访问 .ok。
    if (result && 'ok' in result && result.ok) {
      sendJSON(res, result.status, okResponse(result.data))
      return true
    }
  }

  return false
}
