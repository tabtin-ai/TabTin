/**
 * Session route handler for CLI Server.
 *
 * Session = 命名 Crawlspace，每个 session 在当前 Space 下创建一个独立的
 * Crawlspace（`crawlspaceId = cs-session-{spaceId前8位}-{name}`，实际生成由
 * renderer 的 `tabsSlice.ensureNamedCrawlspace` 决定，会用 `cs-${uuid}` 形式），
 * 实现浏览器身份隔离。
 *
 * partition 由 `BrowserEnvironmentService` 按 Space binding 解析，对外形如
 * `tabtin:env:default` / `tabtin:env:{uuid hex}`（本地化退役 Wave 1+ ADR-3）；
 * 历史的 `tabtin:crawlspace:` 前缀已退役，credential-vault 白名单也已剔除。
 *
 *   - create: 通过 bridge 在渲染进程创建命名 Crawlspace（真正的 partition 隔离）
 *   - switch: 切换当前 Space 的活跃 session，后续 browser open 自动使用该 session
 *   - close:  通过 bridge 清理对应 Crawlspace 的数据
 *   - list:   通过 bridge 查询当前 Space 下的所有命名 session
 *   - save/load: 通过 eval 在 session 关联的 tab 上读写 storage 状态
 */

import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
import { getCLIContextSpaceBridge, getCLISpaceId, getCLIActionExecutor } from '../cli-context'
import { errorResponse } from './shared/error-handler'

type SendJSON = (res: http.ServerResponse, status: number, data: any) => void

const activeSessionBySpace = new Map<string, string>()

/** 获取指定 Space 的活跃 session 名称（不传 spaceId 时用当前 CLI Space） */
export function getActiveSessionName(spaceId?: string): string | null {
  const id = spaceId || getCLISpaceId()
  if (!id) return null
  return activeSessionBySpace.get(id) ?? null
}

/** 清除指定 Space 的活跃 session（不传则清除所有） */
export function clearActiveSession(spaceId?: string): void {
  if (spaceId) {
    activeSessionBySpace.delete(spaceId)
  } else {
    activeSessionBySpace.clear()
  }
}

function requireBridge(res: http.ServerResponse, sendJSON: SendJSON) {
  const bridge = getCLIContextSpaceBridge()
  const spaceId = getCLISpaceId()

  if (!bridge) {
    sendJSON(res, 503, errorResponse('INTERNAL_ERROR', 'TabTin 界面尚未就绪', {
      retryable: true,
      suggestions: ['确保 TabTin 主窗口已显示', '等待几秒后重试'],
    }))
    return null
  }
  if (!spaceId) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '未选择组织，请先在 TabTin 中打开一个 Space', {
      suggestions: ['在 TabTin 中创建或选择一个 Space'],
    }))
    return null
  }

  return { bridge, spaceId }
}

export async function handleSessionRoute(
  url: string,
  _method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/browser\/session/, '')

  // ── List sessions ────────────────────────────────────────

  if (route === '/list' || route === '') {
    const ctx = requireBridge(res, sendJSON)
    if (!ctx) return

    try {
      const result = await ctx.bridge('list_sessions', { spaceId: ctx.spaceId }, 10000)
      const sessions = result?.data?.sessions || []

      sendJSON(res, 200, okResponse({
        sessions: sessions.map((s: any) => ({
          ...s,
          active: s.sessionName === activeSessionBySpace.get(ctx.spaceId),
        })),
        active: activeSessionBySpace.get(ctx.spaceId) ?? null,
      }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  // ── Create session ───────────────────────────────────────

  if (route === '/create') {
    const name = body?.name
    if (!name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return
    }

    const ctx = requireBridge(res, sendJSON)
    if (!ctx) return

    try {
      const result = await ctx.bridge('create_session_crawlspace', {
        spaceId: ctx.spaceId,
        sessionName: name,
        title: body?.title || name,
      }, 15000)

      if (!result?.success) {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result?.error || '创建 session 失败'))
        return
      }

      if (!activeSessionBySpace.has(ctx.spaceId)) {
        activeSessionBySpace.set(ctx.spaceId, name)
      }

      sendJSON(res, 200, okResponse({
        name,
        crawlspaceId: result.data?.crawlspaceId,
        partition: result.data?.partition,
        profile: result.data?.profile,
        active: activeSessionBySpace.get(ctx.spaceId) === name,
      }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  // ── Switch session ───────────────────────────────────────

  if (route === '/switch') {
    const name = body?.name
    if (!name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return
    }

    const ctx = requireBridge(res, sendJSON)
    if (!ctx) return

    try {
      const listResult = await ctx.bridge('list_sessions', { spaceId: ctx.spaceId }, 10000)
      const sessions: Array<{ sessionName: string; crawlspaceId?: string }> =
        listResult?.data?.sessions || []
      const exists = sessions.some(s => s.sessionName === name)

      if (!exists) {
        sendJSON(res, 404, errorResponse('NOT_FOUND', `Session "${name}" 不存在`))
        return
      }

      activeSessionBySpace.set(ctx.spaceId, name)

      const matched = sessions.find(s => s.sessionName === name)
      sendJSON(res, 200, okResponse({
        active: name,
        crawlspaceId: matched?.crawlspaceId,
      }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  // ── Close session ────────────────────────────────────────

  if (route === '/close') {
    const name = body?.name
    if (!name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return
    }

    const ctx = requireBridge(res, sendJSON)
    if (!ctx) return

    try {
      const result = await ctx.bridge('purge_session', {
        spaceId: ctx.spaceId,
        sessionName: name,
      }, 15000)

      if (!result?.success) {
        sendJSON(res, 404, errorResponse('NOT_FOUND', result?.error || `Session "${name}" 不存在`))
        return
      }

      if (activeSessionBySpace.get(ctx.spaceId) === name) {
        activeSessionBySpace.delete(ctx.spaceId)
      }

      sendJSON(res, 200, okResponse({ closed: name, active: activeSessionBySpace.get(ctx.spaceId) ?? null }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  // ── Close all sessions ───────────────────────────────────

  if (route === '/close-all') {
    const ctx = requireBridge(res, sendJSON)
    if (!ctx) return

    try {
      const listResult = await ctx.bridge('list_sessions', { spaceId: ctx.spaceId }, 10000)
      const sessions: Array<{ sessionName: string; crawlspaceId?: string }> =
        listResult?.data?.sessions || []

      let closed = 0
      for (const s of sessions) {
        try {
          await ctx.bridge('purge_session', {
            spaceId: ctx.spaceId,
            sessionName: s.sessionName,
          }, 10000)
          closed++
        } catch { /* ignore individual failures */ }
      }

      activeSessionBySpace.delete(ctx.spaceId)

      sendJSON(res, 200, okResponse({ closed }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  // ── Save session state ───────────────────────────────────

  if (route === '/save') {
    const name = body?.name
    if (!name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return
    }

    const crawlTabId = body?.crawlTabId || body?.tabId
    if (!crawlTabId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 crawlTabId 或 tabId 参数 — 需要指定从哪个标签页保存状态'))
      return
    }

    const executor = getCLIActionExecutor()
    if (!executor) {
      sendJSON(res, 503, errorResponse('INTERNAL_ERROR', 'FrontendActionBridge 尚未初始化'))
      return
    }

    try {
      const result = await executor({
        task_id: `cli-session-save-${Date.now()}`,
        type: 'eval',
        params: {
          code: `
            (function() {
              const cookies = document.cookie;
              const ls = {};
              for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                ls[key] = localStorage.getItem(key);
              }
              const ss = {};
              for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                ss[key] = sessionStorage.getItem(key);
              }
              return { cookies, localStorage: ls, sessionStorage: ss, url: location.href };
            })()
          `,
          crawlTabId,
        },
        thread_id: '',
      })

      sendJSON(res, 200, okResponse({
        name,
        state: result.data ?? result.result ?? result,
      }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  // ── Load session state ───────────────────────────────────

  if (route === '/load') {
    const name = body?.name
    const state = body?.state
    if (!name) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 name 参数'))
      return
    }
    if (!state) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 state 参数'))
      return
    }

    const crawlTabId = body?.crawlTabId || body?.tabId
    if (!crawlTabId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 crawlTabId 或 tabId 参数 — 需要指定将状态加载到哪个标签页'))
      return
    }

    const executor = getCLIActionExecutor()
    if (!executor) {
      sendJSON(res, 503, errorResponse('INTERNAL_ERROR', 'FrontendActionBridge 尚未初始化'))
      return
    }

    try {
      const rawLs = state.localStorage
      const rawSs = state.sessionStorage
      const rawCookies = state.cookies ?? ''

      if (rawLs !== null && rawLs !== undefined && (typeof rawLs !== 'object' || Array.isArray(rawLs))) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'localStorage 必须为普通对象'))
        return
      }
      if (rawSs !== null && rawSs !== undefined && (typeof rawSs !== 'object' || Array.isArray(rawSs))) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'sessionStorage 必须为普通对象'))
        return
      }
      if (typeof rawCookies !== 'string') {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'cookies 必须为字符串'))
        return
      }
      if (/[\r\n]/.test(rawCookies)) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'cookies 包含非法换行符'))
        return
      }

      const validateStringMap = (map: Record<string, unknown>): map is Record<string, string> => {
        return Object.values(map).every(v => typeof v === 'string')
      }
      const lsMap: Record<string, unknown> = rawLs || {}
      const ssMap: Record<string, unknown> = rawSs || {}
      if (!validateStringMap(lsMap)) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'localStorage 的所有值必须为字符串'))
        return
      }
      if (!validateStringMap(ssMap)) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', 'sessionStorage 的所有值必须为字符串'))
        return
      }

      const lsData = JSON.stringify(lsMap)
      const ssData = JSON.stringify(ssMap)
      const cookiesJson = JSON.stringify(rawCookies)

      await executor({
        task_id: `cli-session-load-${Date.now()}`,
        type: 'eval',
        params: {
          code: `
            (function() {
              const ls = ${lsData};
              Object.keys(ls).forEach(k => localStorage.setItem(k, ls[k]));
              const ss = ${ssData};
              Object.keys(ss).forEach(k => sessionStorage.setItem(k, ss[k]));
              const cookies = ${cookiesJson};
              if (cookies) document.cookie = cookies;
              return { loaded: true };
            })()
          `,
          crawlTabId,
        },
        thread_id: '',
      })

      const spaceId = getCLISpaceId()
      if (spaceId) activeSessionBySpace.set(spaceId, name)
      sendJSON(res, 200, okResponse({ name, active: true, loaded: true }))
    } catch (err: any) {
      sendJSON(res, 500, errorResponse('INTERNAL_ERROR', err?.message || String(err)))
    }
    return
  }

  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `Unknown session route: ${url}`))
}
