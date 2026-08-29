import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
import type { SendJSON, ActionExecutor } from './_helpers'
import {
  buildBrowserRequestScope,
  resolveTabId,
  makeTaskId,
  sendExecutorResult,
  errorResponse,
  handleRouteError,
} from './_helpers'
import { BrowserTabUserInControlError } from '../../../browser-tab-lock/browserTabInputLock'

const batchLocks = new Map<string, Promise<void>>()

// BT-006: 加超时保护，防止子路由永久挂起导致外层 await 泄漏
async function acquireBatchLock(tabId: string, timeoutMs = 30_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs
  while (batchLocks.has(tabId)) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await Promise.race([
      batchLocks.get(tabId)!,
      new Promise<void>(r => setTimeout(r, Math.min(remaining, 5_000))),
    ])
  }
  let release!: () => void
  const lock = new Promise<void>(r => { release = r })
  batchLocks.set(tabId, lock)
  return () => { batchLocks.delete(tabId); release() }
}

export async function handleSessionRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
  handleBrowserRoute: (url: string, method: string, body: any, res: http.ServerResponse, sendJSON: SendJSON) => Promise<void>,
): Promise<boolean> {
  const requestScope = buildBrowserRequestScope(body)

  if (route === '/cookies') {
    const action = body?.action
    if (!action || !['get', 'set', 'clear'].includes(action)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'action 必须是 get/set/clear', {
        suggestions: ['示例: tabtin browser cookies get --tab auto', 'tabtin browser cookies clear --tab auto'],
      }))
      return true
    }
    const tabId = await resolveTabId(body?.tabId, requestScope)
    const result = await executor({
      task_id: makeTaskId('cookies'),
      type: 'manage_cookies',
      params: { action, domain: body?.domain, url: body?.url, cookies: body?.cookies, crawlTabId: tabId },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  if (route === '/clear-session') {
    const tabId = await resolveTabId(body?.tabId, requestScope)
    const result = await executor({
      task_id: makeTaskId('clear-session'),
      type: 'clear_session',
      params: { clearCookies: body?.clearCookies ?? true, clearLocalStorage: body?.clearLocalStorage ?? true, clearCache: body?.clearCache ?? true, crawlTabId: tabId },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  if (route === '/random-ua') {
    const result = await executor({
      task_id: makeTaskId('random-ua'),
      type: 'get_random_ua',
      params: { platform: body?.platform || 'desktop' },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  if (route === '/batch') {
    const actions = body?.actions
    if (!actions || !Array.isArray(actions)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 actions 数组参数', {
        suggestions: ['batch 命令需要 actions 数组，格式: [{"type":"act","actions":[...]},...]'],
      }))
      return true
    }

    const lockKey = body?.tabId || '__global'
    const release = await acquireBatchLock(lockKey)

    try {
      const stopOnError = body?.stopOnError !== false
      const results: any[] = []

      for (const action of actions) {
        try {
          const actionType = action.type
          const actionParams =
            action?.params && typeof action.params === 'object' && !Array.isArray(action.params)
              ? action.params
              : {}
          const actionBody = {
            ...actionParams,
            ...action,
            runId: requestScope.runId,
            tabId: action.tabId || actionParams.tabId || body?.tabId,
            ...requestScope,
          }
          delete actionBody.type
          delete actionBody.params
          delete actionBody._thread_id
          delete actionBody.thread_id
          delete actionBody.threadId
          if (requestScope._thread_id) {
            actionBody._thread_id = requestScope._thread_id
          }

          const internalUrl = `/browser/${actionType}`
          const resultPromise = new Promise<{ status: number; payload: any }>((resolve) => {
            let resolved = false
            const safeResolve = (status: number, payload: any) => {
              if (!resolved) {
                resolved = true
                resolve({ status, payload })
              }
            }
            const batchSendJSON = (_r: any, status: number, payload: any) =>
              safeResolve(status, payload)
            // BT-005: 传入 noop res，防止子路由直接写入真实连接与 batchSendJSON 产生双写
            const noopRes = {
              write: () => {},
              end: () => {},
              setHeader: () => {},
              writeHead: () => {},
            } as unknown as http.ServerResponse
            handleBrowserRoute(internalUrl, 'POST', actionBody, noopRes, batchSendJSON)
              .catch((err: any) => {
                if (err instanceof BrowserTabUserInControlError) {
                  handleRouteError(err, batchSendJSON, noopRes)
                  return
                }
                safeResolve(500, { ok: false, error: err?.message })
              })
          })

          const { status, payload: result } = await resultPromise
          if (
            status === 409
            && result?.ok === false
            && result?.error?.code === 'BROWSER_TAB_USER_IN_CONTROL'
          ) {
            sendJSON(res, status, result)
            return true
          }
          results.push({ type: actionType, ...result })
          if (stopOnError && result.ok === false) break
        } catch (err: any) {
          results.push({ type: action.type, ok: false, error: err?.message })
          if (stopOnError) break
        }
      }

      const allOk = results.every(r => (r as any).ok !== false)
      if (allOk) {
        sendJSON(res, 200, okResponse({ results, executed: results.length, total: actions.length }))
      } else {
        sendJSON(res, 200, { ok: false, data: { results, executed: results.length, total: actions.length } })
      }
    } finally {
      release()
    }
    return true
  }

  return false
}
