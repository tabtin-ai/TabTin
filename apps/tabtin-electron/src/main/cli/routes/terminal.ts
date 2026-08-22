/**
 * Terminal CLI routes — open / list TabTin in-app interactive terminals.
 *
 * Agent 说「打开终端」应走这里（应用内 xterm + node-pty），
 * 而不是 `tabtin desktop open PowerShell`（外部系统终端）。
 */

import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
import { getCLIContextSpaceBridge, getCLISpaceId } from '../cli-context'
import { errorResponse } from './shared/error-handler'

type SendJSON = (res: http.ServerResponse, status: number, data: unknown) => void

function requireBridge(res: http.ServerResponse, sendJSON: SendJSON, body?: Record<string, unknown>) {
  const bridge = getCLIContextSpaceBridge()
  const spaceId =
    (typeof body?.spaceId === 'string' && body.spaceId) ||
    (typeof body?.space_id === 'string' && body.space_id) ||
    getCLISpaceId()

  if (!bridge) {
    sendJSON(res, 503, errorResponse('INTERNAL_ERROR', 'TabTin 界面尚未就绪', {
      retryable: true,
      suggestions: ['确保 TabTin 主窗口已显示', '等待几秒后重试'],
    }))
    return null
  }
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '未选择 Space，请先在 TabTin 中打开一个 Space', {
      suggestions: ['在 TabTin 中创建或选择一个 Space'],
    }))
    return null
  }

  return { bridge, spaceId }
}

function readString(body: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!body) return undefined
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

export async function handleTerminalRoute(
  url: string,
  _method: string,
  body: Record<string, unknown> | undefined,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/terminal/, '') || '/'

  if (route === '/open') {
    const ctx = requireBridge(res, sendJSON, body)
    if (!ctx) return

    const title = readString(body, 'title')
    const cwd = readString(body, 'cwd')
    const sessionId = readString(body, 'sessionId', 'session_id')

    try {
      const result = await ctx.bridge('open_terminal_tab', {
        spaceId: ctx.spaceId,
        ...(title ? { title } : {}),
        ...(cwd ? { cwd } : {}),
        ...(sessionId ? { sessionId } : {}),
      }, 15000)

      if (!result?.success) {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result?.error || '打开应用内终端失败', {
          suggestions: [
            '确认当前设备是 Agent 的控制设备',
            '重试 tabtin terminal open',
          ],
        }))
        return
      }

      sendJSON(res, 200, okResponse({
        sessionId: result.data?.sessionId,
        tabKey: result.data?.tabKey,
        created: result.data?.created ?? true,
        title: result.data?.title,
        cwd: result.data?.cwd,
      }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', message))
    }
    return
  }

  if (route === '/list' || route === '/') {
    const ctx = requireBridge(res, sendJSON, body)
    if (!ctx) return

    try {
      const result = await ctx.bridge('list_terminal_sessions', {
        spaceId: ctx.spaceId,
      }, 10000)

      if (!result?.success) {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result?.error || '列出终端会话失败'))
        return
      }

      sendJSON(res, 200, okResponse({
        sessions: result.data?.sessions ?? [],
      }))
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', message))
    }
    return
  }

  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知的终端路由：${url}。请使用 tabtin terminal open 或 tabtin terminal list。`))
}
