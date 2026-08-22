/**
 * Browser route dispatcher for CLI Server.
 *
 * Delegates to domain-specific sub-modules under `./browser/`.
 * Each handler returns `true` if it consumed the route, `false` otherwise.
 */

import http from 'node:http'
import { getCLIActionExecutor } from '../cli-context'
import { errorResponse } from './shared/error-handler'
import type { SendJSON } from './browser/_helpers'
import { handleTabsRoute } from './browser/tabs'
import { handleInteractionRoute } from './browser/interaction'
import { handlePrintRoute } from './browser/print'
import { handleResourcesRoute } from './browser/resources'
import { handleJobRoute } from './browser/job'
import { handleNetworkRoute } from './browser/network'
import { handleSessionRoute } from './browser/browser-utils'
import { handleSessionRoute as handleSessionMgmtRoute } from './session'
import { handleRecordRoute } from './browser/record'
import { handleRunRoute } from './browser/run'
import { handleIntrospectRoute } from './browser/introspect'
import { handleCollectRoute } from './browser/collect'
import { handleBrowserHomeRoute } from './browser/home'

// BR-8 P3a：RefCache 已收编进 browser-core 共享 runtime（getSharedRefCache）。
// 原先经本文件 re-export 的 getRefCache/clearRefCache/setRefCache 全仓无消费者，
// 随收编一并移除（消费方直接用 @tabtin/browser-core 的 getSharedRefCache）。

export async function handleBrowserRoute(
  url: string,
  _method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/browser/, '')
  if (!body) body = {}

  // 自描述路由（context / capabilities）：只读、不依赖 action executor / View，
  // 放在 executor 闸门**之前**——即使前端 / bridge 尚未就绪也能回答「我是谁、能干什么」。
  if (await handleIntrospectRoute(route, body, res, sendJSON)) return

  const executor = getCLIActionExecutor()
  if (!executor) {
    sendJSON(res, 503, errorResponse('INTERNAL_ERROR', 'TabTin 正在启动中，请稍后重试（通常需要 5-10 秒）', {
      retryable: true,
      suggestions: ['确保 TabTin 应用已完全启动', '等待几秒后重试', '运行 tabtin doctor 进行环境诊断'],
    }))
    return
  }

  if (await handleTabsRoute(route, body, res, sendJSON, executor)) return
  if (await handleInteractionRoute(route, body, res, sendJSON, executor)) return
  if (await handlePrintRoute(route, body, res, sendJSON, executor)) return
  if (await handleResourcesRoute(route, body, res, sendJSON, executor)) return
  if (await handleJobRoute(route, body, res, sendJSON, executor)) return
  if (await handleNetworkRoute(route, body, res, sendJSON, executor)) return
  if (await handleCollectRoute(route, body, res, sendJSON, executor)) return
  if (await handleBrowserHomeRoute(route, body, res, sendJSON)) return
  if (await handleSessionRoute(route, body, res, sendJSON, executor, handleBrowserRoute)) return
  if (route.startsWith('/session/') || route === '/session') {
    await handleSessionMgmtRoute(`/browser${route}`, _method, body, res, sendJSON)
    return
  }
  if (await handleRecordRoute(route, body, res, sendJSON, executor)) return
  if (await handleRunRoute(route, body, res, sendJSON, executor)) return

  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知的 browser 命令: ${url}`, {
    suggestions: [
      '使用 tabtin browser --help 查看所有可用命令',
      '常用命令: open, glance, act, print, eval, tab list',
    ],
  }))
}
