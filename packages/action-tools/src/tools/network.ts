/**
 * Network Intelligence Tools
 *
 * Provides request interception, network logging, and console message
 * capture for browser automation scenarios.
 */

import type { AgentTool } from '../types'
import type { ToolError } from '../types/errors'
import { ToolErrorCode } from '../types/errors'
import { standardizeLegacyResult } from '../utils/tool-output'
import { t } from '../i18n'
// BR-8 P3b：network/console 历史读自 browser-core 的双端共享缓冲（写入由两端的
// attachRuntimeLogCapture 经 BrowserContext.onCDPEvent 常驻喂入）。本模块不再自持
// 并行 network/console Map —— route 拦截规则（route/unroute）仍留在本地。
import { getSharedNetworkLog, getSharedConsoleLog } from '@tabtin/browser-core'

// ── Types ─────────────────────────────────────────────────

export interface RouteRule {
  id: string
  urlPattern: string
  status?: number
  body?: string
  headers?: Record<string, string>
  createdAt: number
}

export interface NetworkLogEntry {
  requestId?: string
  url: string
  method: string
  status?: number
  resourceType?: string
  mimeType?: string
  size?: number
  requestHeaders?: Record<string, string>
  requestBody?: string
  responseHeaders?: Record<string, string>
  responseBody?: string
  responseBodyBase64Encoded?: boolean
  bodyTruncated?: boolean
  responseBodyError?: string
  timestamp: number
  runId?: string
}

export interface ConsoleLogEntry {
  level: string
  text: string
  timestamp: number
  source?: string
  runId?: string
}

// ── Input / Output interfaces ─────────────────────────────

export interface RouteInput {
  urlPattern: string
  status?: number
  body?: string
  headers?: Record<string, string>
  crawlTabId?: string
}

export interface RouteOutput {
  success: boolean
  data?: RouteRule
  error?: ToolError
}

export interface RouteListInput {
  crawlTabId?: string
}

export interface RouteListOutput {
  success: boolean
  data?: RouteRule[]
  error?: ToolError
}

export interface UnrouteInput {
  ruleId?: string
  urlPattern?: string
  crawlTabId?: string
}

export interface UnrouteOutput {
  success: boolean
  data?: { removed: boolean }
  error?: ToolError
}

export interface NetworkLogInput {
  filter?: string
  runId?: string
  crawlTabId?: string
  includeRequestHeaders?: boolean
  includeRequestBody?: boolean
  includeResponseHeaders?: boolean
  includeResponseBody?: boolean
  /**
   * 默认 true（脱敏）。仅可信内部消费方（platform-reach）显式 false 取原始响应体，
   * 用于提取 `xsec_token` 等被脱敏正则误伤的内容寻址签名。勿在 agent/导出路径传 false。
   */
  redactResponseBody?: boolean
}

export interface NetworkLogOutput {
  success: boolean
  data?: NetworkLogEntry[]
  error?: ToolError
}

export interface ConsoleLogInput {
  level?: string
  runId?: string
  crawlTabId?: string
}

export interface ConsoleLogOutput {
  success: boolean
  data?: ConsoleLogEntry[]
  error?: ToolError
}

// ── In-memory state per tab ───────────────────────────────
// network/console 历史已收编进 browser-core 共享缓冲（BR-8 P3b）；此处只留
// route 拦截规则（route/unroute 由 CDP Fetch 域消费，仍是 route 层状态）。

const routeRules = new Map<string, RouteRule[]>()

let ruleIdCounter = 0

// ── Callback for CDP-side interception refresh ────────────

type InterceptionCallback = (tabId: string) => void
let onRulesChangedCb: InterceptionCallback | null = null

export function setOnRulesChanged(cb: InterceptionCallback | null): void {
  onRulesChangedCb = cb
}

// ── Public API for route management ───────────────────────

export function addRouteRule(tabId: string, rule: Omit<RouteRule, 'id' | 'createdAt'>): RouteRule {
  const entry: RouteRule = {
    ...rule,
    id: `route-${++ruleIdCounter}`,
    createdAt: Date.now(),
  }
  if (!routeRules.has(tabId)) {
    routeRules.set(tabId, [])
  }
  routeRules.get(tabId)!.push(entry)
  onRulesChangedCb?.(tabId)
  return entry
}

export function getRouteRules(tabId: string): RouteRule[] {
  return routeRules.get(tabId) || []
}

export function removeRouteRule(tabId: string, ruleId: string): boolean {
  const rules = routeRules.get(tabId)
  if (!rules) return false
  const idx = rules.findIndex(r => r.id === ruleId)
  if (idx === -1) return false
  rules.splice(idx, 1)
  onRulesChangedCb?.(tabId)
  return true
}

export function removeRouteRuleByPattern(tabId: string, urlPattern: string): boolean {
  const rules = routeRules.get(tabId)
  if (!rules) return false
  const idx = rules.findIndex(r => r.urlPattern === urlPattern)
  if (idx === -1) return false
  rules.splice(idx, 1)
  onRulesChangedCb?.(tabId)
  return true
}

// ── Tool definitions ──────────────────────────────────────

export const routeTool: AgentTool<RouteInput, RouteOutput> = {
  name: 'browser_route',
  description: t('tools.network.route.description'),
  parameters: {
    type: 'object',
    properties: {
      urlPattern: { type: 'string', description: t('tools.network.route.params.urlPattern') },
      status: { type: 'number', description: t('tools.network.route.params.status') },
      body: { type: 'string', description: t('tools.network.route.params.body') },
      headers: { type: 'object', description: t('tools.network.route.params.headers') },
      crawlTabId: { type: 'string' },
    },
    required: ['urlPattern'],
  },
  async execute(input: RouteInput): Promise<RouteOutput> {
    try {
      if (!input.urlPattern || typeof input.urlPattern !== 'string') {
        return standardizeLegacyResult({
          success: false,
          error: 'urlPattern is required and must be a string',
          error_code: ToolErrorCode.INVALID_PARAMETER,
        }) as unknown as RouteOutput
      }

      const tabId = input.crawlTabId || '__default'
      const rule = addRouteRule(tabId, {
        urlPattern: input.urlPattern,
        status: input.status,
        body: input.body,
        headers: input.headers,
      })
      return standardizeLegacyResult({ success: true, data: rule }) as unknown as RouteOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as RouteOutput
    }
  },
}

export const routeListTool: AgentTool<RouteListInput, RouteListOutput> = {
  name: 'browser_route_list',
  description: t('tools.network.routeList.description'),
  parameters: {
    type: 'object',
    properties: {
      crawlTabId: { type: 'string' },
    },
    required: [],
  },
  async execute(input: RouteListInput): Promise<RouteListOutput> {
    try {
      const tabId = input.crawlTabId || '__default'
      return standardizeLegacyResult({ success: true, data: getRouteRules(tabId) }) as unknown as RouteListOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as RouteListOutput
    }
  },
}

export const unrouteTool: AgentTool<UnrouteInput, UnrouteOutput> = {
  name: 'browser_unroute',
  description: t('tools.network.unroute.description'),
  parameters: {
    type: 'object',
    properties: {
      ruleId: { type: 'string', description: t('tools.network.unroute.params.ruleId') },
      urlPattern: { type: 'string', description: 'URL pattern used when registering the route' },
      crawlTabId: { type: 'string' },
    },
    required: [],
  },
  async execute(input: UnrouteInput): Promise<UnrouteOutput> {
    try {
      if (
        (!input.ruleId || typeof input.ruleId !== 'string') &&
        (!input.urlPattern || typeof input.urlPattern !== 'string')
      ) {
        return standardizeLegacyResult({
          success: false,
          error: 'ruleId or urlPattern is required and must be a string',
          error_code: ToolErrorCode.INVALID_PARAMETER,
        }) as unknown as UnrouteOutput
      }

      const tabId = input.crawlTabId || '__default'
      const removed = input.ruleId
        ? removeRouteRule(tabId, input.ruleId)
        : removeRouteRuleByPattern(tabId, input.urlPattern!)
      return standardizeLegacyResult({ success: removed, data: { removed } }) as unknown as UnrouteOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as UnrouteOutput
    }
  },
}

export const networkLogTool: AgentTool<NetworkLogInput, NetworkLogOutput> = {
  name: 'browser_network',
  description: t('tools.network.networkLog.description'),
  parameters: {
    type: 'object',
    properties: {
      filter: { type: 'string', description: t('tools.network.networkLog.params.filter') },
      runId: { type: 'string', description: t('tools.network.networkLog.params.runId') },
      crawlTabId: { type: 'string' },
      includeRequestHeaders: { type: 'boolean' },
      includeRequestBody: { type: 'boolean' },
      includeResponseHeaders: { type: 'boolean' },
      includeResponseBody: { type: 'boolean' },
    },
    required: [],
  },
  async execute(input: NetworkLogInput): Promise<NetworkLogOutput> {
    try {
      if (input.filter && typeof input.filter !== 'string') {
        return standardizeLegacyResult({
          success: false,
          error: 'filter must be a string',
          error_code: ToolErrorCode.INVALID_PARAMETER,
        }) as unknown as NetworkLogOutput
      }

      // 验证 filter 是合法的正则表达式
      if (input.filter) {
        try {
          new RegExp(input.filter, 'i')
        } catch {
          return standardizeLegacyResult({
            success: false,
            error: `Invalid filter regex: ${input.filter}`,
            error_code: ToolErrorCode.INVALID_PARAMETER,
          }) as unknown as NetworkLogOutput
        }
      }

      const tabId = input.crawlTabId || '__default'
      // 读 browser-core 共享缓冲：过滤 / 投影 / 脱敏均在 query 内完成（双端同一实现）。
      const data = getSharedNetworkLog().query(tabId, {
        filter: input.filter,
        runId: input.runId,
        includeRequestHeaders: input.includeRequestHeaders,
        includeRequestBody: input.includeRequestBody,
        includeResponseHeaders: input.includeResponseHeaders,
        includeResponseBody: input.includeResponseBody,
        redactResponseBody: input.redactResponseBody,
      }) as NetworkLogEntry[]
      return standardizeLegacyResult({ success: true, data }) as unknown as NetworkLogOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as NetworkLogOutput
    }
  },
}

export const consoleLogTool: AgentTool<ConsoleLogInput, ConsoleLogOutput> = {
  name: 'browser_console',
  description: t('tools.network.consoleLog.description'),
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', description: t('tools.network.consoleLog.params.level') },
      runId: { type: 'string', description: t('tools.network.consoleLog.params.runId') },
      crawlTabId: { type: 'string' },
    },
    required: [],
  },
  async execute(input: ConsoleLogInput): Promise<ConsoleLogOutput> {
    try {
      if (input.level && typeof input.level !== 'string') {
        return standardizeLegacyResult({
          success: false,
          error: 'level must be a string',
          error_code: ToolErrorCode.INVALID_PARAMETER,
        }) as unknown as ConsoleLogOutput
      }

      const tabId = input.crawlTabId || '__default'
      // 读 browser-core 共享缓冲（写入由两端 attachRuntimeLogCapture 经 onCDPEvent 喂入）。
      const data = getSharedConsoleLog().query(tabId, {
        level: input.level,
        runId: input.runId,
      }) as ConsoleLogEntry[]
      return standardizeLegacyResult({ success: true, data }) as unknown as ConsoleLogOutput
    } catch (error) {
      return standardizeLegacyResult({
        success: false,
        error: error instanceof Error ? error.message : String(error),
        error_code: ToolErrorCode.UNKNOWN_ERROR,
      }) as unknown as ConsoleLogOutput
    }
  },
}

export const networkTools = [
  routeTool,
  routeListTool,
  unrouteTool,
  networkLogTool,
  consoleLogTool,
]
