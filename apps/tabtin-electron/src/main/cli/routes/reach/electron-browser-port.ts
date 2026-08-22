/**
 * Electron 端 BrowserPrimitives 端口实现（P0.5 接线）
 *
 * platform-reach 是 electron-free 纯包，适配器只依赖 `BrowserPrimitives` 端口。
 * 这里把端口接到 Electron 既有的浏览器执行栈——**不新造引擎**：
 *  - open      → 复用 `/open` route（handleTabsRoute），与 collect.ts 同款
 *  - captureNetwork → `browser_network` action（读 NetworkLog 历史缓冲）
 *  - eval      → `eval` action（页面上下文求值）
 *
 * Daemon 端口是 P2（headless 登录态桥）；本文件只服务 Electron 桌面（P0/P1 锁定）。
 */
import http from 'node:http'
import type {
  BrowserPrimitives,
  CaptureNetworkInput,
  NetworkCaptureEntry,
  OpenInput,
  OpenResult,
  WaitForInput,
} from '@tabtin/platform-reach'
import type { NetworkLogEntry } from '@tabtin/browser-core'
import { createLogger } from '../../../logger'
import { enableForTab } from '../../../services/CDPNetworkBridge'
import { getViewFactory } from '../../../view-factory'
import type { ActionExecutor, SendJSON } from '../browser/_helpers'
import { isSafeUrl, makeTaskId } from '../browser/_helpers'
import { handleTabsRoute } from '../browser/tabs'

const log = createLogger('reach-browser-port')

const DEFAULT_CAPTURE_TIMEOUT_MS = 8000
const CAPTURE_POLL_INTERVAL_MS = 400
// webview guest 异步收养：等 getWebContents 就绪的上限与轮询间隔。
const GUEST_READY_TIMEOUT_MS = 6000
const GUEST_POLL_INTERVAL_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 比较导航目标是否实质相同（忽略 hash；query 顺序敏感即可）。 */
function normalizeUrlForCompare(raw: string): string {
  try {
    const u = new URL(raw)
    u.hash = ''
    return u.href
  } catch {
    return raw
  }
}

/**
 * 复用 `/open` route 打开/导航 tab（不经 cli-server 的 /browser 策略预评，
 * 与 collect.ts 的 invokeOpenRoute 同款——read 动词无需写审批）。
 */
async function invokeOpenRoute(
  body: Record<string, unknown>,
  executor: NonNullable<ActionExecutor>,
): Promise<Record<string, any>> {
  const responses: Array<{ status: number; data: any }> = []
  const captureSendJSON: SendJSON = (_res, status, data) => {
    responses.push({ status, data })
  }
  await handleTabsRoute(
    '/open',
    body,
    {} as http.ServerResponse,
    captureSendJSON,
    executor,
  )
  const captured = responses[0]
  if (!captured) throw new Error('browser open route did not return a response')
  const payload = captured.data?.data ?? captured.data
  if (captured.status >= 400 || captured.data?.ok === false) {
    throw new Error(
      captured.data?.error?.message || payload?.error || '打开 URL 失败',
    )
  }
  return payload
}

/** eval action 的返回体形状不定；解开一层并对字符串结果尝试 JSON.parse。 */
function unwrapEvalResult(result: any): unknown {
  const raw = result?.data?.result ?? result?.result ?? result?.data
  if (typeof raw !== 'string') return raw
  const trimmed = raw.trim()
  if (!trimmed) return raw
  try {
    return JSON.parse(trimmed)
  } catch {
    return raw
  }
}

/**
 * 构造一个 Electron 端 BrowserPrimitives。每次 reach run 建一个（绑定当前
 * space/crawlspace 作用域），传给适配器的 RunContext.browser。
 */
export function createElectronBrowserPort(
  executor: NonNullable<ActionExecutor>,
  scope: { spaceId?: string; crawlspaceId?: string } = {},
): BrowserPrimitives {
  const scopeBody = {
    ...(scope.spaceId ? { spaceId: scope.spaceId } : {}),
    ...(scope.crawlspaceId ? { crawlspaceId: scope.crawlspaceId } : {}),
  }

  return {
          async open(input: OpenInput): Promise<OpenResult> {
            if (!isSafeUrl(input.url)) {
              throw new Error(`不允许的 URL 协议: ${input.url}。仅支持 http/https`)
            }
            const payload = await invokeOpenRoute(
              {
                ...scopeBody,
                url: input.url,
                ...(input.tabId ? { tabId: input.tabId } : {}),
                // 适配器按平台契约拼详情 URL（如抖音 /video/<id>），不经页面观测；
                // 跳过二级页反幻觉守卫。仅 reach 内部端口设置，不暴露给 Agent CLI。
                skipNavigationEvidenceCheck: true,
              },
              executor,
            )
            const rawTabId = payload?.tabId ?? payload?.viewId
            if (!rawTabId) throw new Error('open 未返回 tabId')
            const tabId = String(rawTabId)

            // network-intercept 关键时序：attachRuntimeLogCapture 的契约是「导航前
            // Network.enable」。若捕获在本次导航期间尚未挂上（新建 tab 的首次导航
            // 就是这种情况），首屏 API 响应（如小红书 search/notes）会在捕获开启前
            // 发完 → NetworkLog 全漏。这里保证捕获挂上后**重放一次导航**，让接口在
            // 捕获开启后重新触发；tab 已带捕获（如 read 复用 search 的 tab）则不重放。
            try {
              // webview 容器下 guest 是**异步收养**的：open route 立即返回 tabId，
              // 但 renderer 的 <webview> guest 要过一会儿才 attach 进主进程，
              // ViewFactory.getWebContents 在收养前返回 null。这里轮询等 guest 就绪。
              let wc = getViewFactory().getWebContents(tabId)
              const waitDeadline = Date.now() + GUEST_READY_TIMEOUT_MS
              while ((!wc || wc.isDestroyed()) && Date.now() < waitDeadline) {
                await delay(GUEST_POLL_INTERVAL_MS)
                wc = getViewFactory().getWebContents(tabId)
              }
              if (wc && !wc.isDestroyed()) {
                // 确保 CDP 网络捕获挂上（enableForTab 幂等：已挂则立即返回）。
                await enableForTab(wc, tabId)
                // 重放导航：首屏 API 在捕获挂上前已发完（webview guest 收养晚于首屏），
                // 直接对 guest webContents 重载，让接口在捕获开启后重新触发被录下来。
                // 注意：对**同一 URL** 再 `loadURL` 常被当成 no-op（SPA/Chromium 不重发
                // XHR/SSE）——同花顺问财 stream-query 就会因此永远进不了 NetworkLog。
                // 同 URL 时用 reloadIgnoringCache 强制重拉。
                const currentUrl = (() => {
                  try {
                    return wc.getURL()
                  } catch {
                    return ''
                  }
                })()
                const sameUrl =
                  !!currentUrl &&
                  (currentUrl === input.url ||
                    normalizeUrlForCompare(currentUrl) ===
                      normalizeUrlForCompare(input.url))
                if (sameUrl) {
                  await Promise.resolve(wc.reloadIgnoringCache()).catch(() => {
                    /* 重放失败不阻断 */
                  })
                } else {
                  await wc.loadURL(input.url).catch(() => {
                    /* 重放导航失败不阻断：captureNetwork 仍会尽力读已有缓冲 */
                  })
                }
              }
            } catch (err) {
              log.warn('reach open：挂载网络捕获/重放导航失败，可能拦不到首屏 API', {
                tabId,
                message: err instanceof Error ? err.message : String(err),
              })
            }

            return {
              tabId,
              url: typeof payload?.url === 'string' ? payload.url : input.url,
              ...(typeof payload?.title === 'string' ? { title: payload.title } : {}),
            }
          },

    async captureNetwork(
      input: CaptureNetworkInput,
    ): Promise<NetworkCaptureEntry[]> {
      const timeoutMs = input.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      const pattern = input.urlPattern
      const bodyIncludes = input.bodyIncludes
      let last: NetworkCaptureEntry[] = []

      // NetworkLog 是历史缓冲，响应体经 Network.getResponseBody 异步回填，
      // 因此轮询到「命中 pattern 且 responseBody 就绪」或超时。
      // bodyIncludes：流式/SSE 可能先回半截 body，需等到关键子串出现再返回。
      do {
        const result = await executor({
          task_id: makeTaskId('reach-network'),
          type: 'browser_network',
          params: {
            crawlTabId: input.tabId,
            ...(pattern ? { filter: pattern } : {}),
            includeRequestHeaders: false,
            includeRequestBody: false,
            includeResponseHeaders: false,
            includeResponseBody: true,
            // 可信内部提取：取原始体拿 xsec_token（脱敏正则会把它误判为 token 打码，
            // 破坏 search→read 两跳）。仅 reach 内部用，不经 agent-facing schema。
            redactResponseBody: false,
          },
          thread_id: '',
        })
        if (result?.success !== false) {
          const entries = (Array.isArray(result?.data) ? result.data : []) as NetworkLogEntry[]
          last = entries.map((e) => ({
            url: e.url,
            method: e.method,
            ...(e.status !== undefined ? { status: e.status } : {}),
            ...(e.responseBody !== undefined
              ? { responseBody: e.responseBody }
              : {}),
            ...(e.mimeType !== undefined ? { contentType: e.mimeType } : {}),
          }))
          const hitEntry = last.find(
            (e) =>
              e.responseBody &&
              (!pattern || e.url.includes(pattern)) &&
              (!bodyIncludes || e.responseBody.includes(bodyIncludes)),
          )
          if (hitEntry) {
            return last
          }
        }
        if (Date.now() >= deadline) break
        await delay(CAPTURE_POLL_INTERVAL_MS)
      } while (Date.now() < deadline)

      if (last.length === 0) {
        log.warn('captureNetwork 超时未拦到匹配响应', {
          tabId: input.tabId,
          pattern,
          timeoutMs,
        })
      }
      return last
    },

    async eval(input: { tabId: string; expression: string }): Promise<unknown> {
      const result = await executor({
        task_id: makeTaskId('reach-eval'),
        type: 'eval',
        params: { crawlTabId: input.tabId, code: input.expression },
        thread_id: '',
      })
      if (result?.success === false) {
        throw new Error(result.error || 'eval 失败')
      }
      return unwrapEvalResult(result)
    },

    async waitFor(input: WaitForInput): Promise<void> {
      const timeoutMs = input.timeoutMs ?? 5000
      const deadline = Date.now() + timeoutMs
      const expr = input.selector
        ? `!!document.querySelector(${JSON.stringify(input.selector)})`
        : input.text
          ? `document.body && document.body.innerText.includes(${JSON.stringify(input.text)})`
          : 'true'
      while (Date.now() < deadline) {
        const ok = await this.eval({ tabId: input.tabId, expression: expr })
        if (ok === true) return
        await delay(250)
      }
    },
  }
}
