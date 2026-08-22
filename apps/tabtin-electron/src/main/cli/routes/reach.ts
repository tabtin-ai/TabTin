/**
 * `/reach/*` 路由（Platform Reach P0.5 接线）
 *
 * 把 `@tabtin/platform-reach` 纯包接到 Electron 浏览器执行栈：
 *   - POST /reach/doctor        → 选路探测（哪个后端此刻能服务该平台/动词）
 *   - POST /reach/<verb>        → 执行某平台某动词，返回 NormalizedItem[]
 *
 * 动词是从路径段动态取的（search / read / comments …），对平台/动词做能力校验；
 * **新增动词零改本文件**——只加 Go CommandDef + 适配器 verbs（generality 原则）。
 *
 * 合规默认：`--use-login`（显式登录态批量采集）暂拒。
 * 若 TabWeb 分区里已有该站会话 cookie，reach 会复用该会话；结果里的
 * `authContext` 反映**实际会话**（logged-in / anonymous），≠ 开放批量采集开关。
 */
import http from 'node:http'
import { session as electronSession } from 'electron'
import { okResponse } from '@tabtin/agent-wire'
import {
  AdapterRegistry,
  createDefaultRegistry,
  selectBackend,
  describeChoice,
  resolveSearchConstraints,
  decideSearchRouting,
  type AuthContext,
  type BackendChoice,
  type PlatformAdapter,
  type PlatformProbe,
  type RequestedSearchConstraint,
  type Verb,
  type NormalizedItem,
  type RunContext,
} from '@tabtin/platform-reach'
import { getBrowserEnvironmentService } from '../../browser-env/BrowserEnvironmentService'
import { createLogger } from '../../logger'
import type { SendJSON } from './browser/_helpers'
import {
  errorResponse,
  getCLIActionExecutor,
  getCLISpaceId,
  getCLICrawlspaceId,
  resolveTabId,
} from './browser/_helpers'
import { createElectronBrowserPort } from './reach/electron-browser-port'

const log = createLogger('reach-route')

/**
 * 与各适配器 session.probeLoggedIn 的 cookie 线索对齐。
 * 不走页面 eval：`document.cookie` 会被 content-ops 脚本策略拦截。
 */
const PLATFORM_LOGIN_COOKIE_HINTS: Record<
  string,
  { probeUrls: string[]; cookieNames: string[] }
> = {
  taobao: {
    probeUrls: ['https://www.taobao.com/'],
    cookieNames: ['cookie2', '_m_h5_tk'],
  },
  tmall: {
    // 天猫与淘宝常共享阿里系会话；两边都查
    probeUrls: ['https://www.tmall.com/', 'https://www.taobao.com/'],
    cookieNames: ['cookie2', '_m_h5_tk'],
  },
  jd: {
    probeUrls: ['https://www.jd.com/'],
    cookieNames: ['pin', 'thor'],
  },
  bilibili: {
    probeUrls: ['https://www.bilibili.com/'],
    cookieNames: ['DedeUserID'],
  },
  douyin: {
    probeUrls: ['https://www.douyin.com/'],
    cookieNames: ['sessionid', 'passport_csrf_token'],
  },
  xiaohongshu: {
    probeUrls: ['https://www.xiaohongshu.com/'],
    cookieNames: ['web_session', 'customer-sso-sid'],
  },
}

/** 内置适配器注册表，进程内单例。 */
let registrySingleton: AdapterRegistry | undefined
function getRegistry(): AdapterRegistry {
  if (!registrySingleton) registrySingleton = createDefaultRegistry()
  return registrySingleton
}

export type LoginProbeStatus = 'ok' | 'unknown' | 'skipped'

export interface LoginProbeResult {
  status: LoginProbeStatus
  loggedIn: boolean
  /** 用于 cookies.get({ url }) 的探测 URL */
  probeUrl?: string
  /** 命中的登录 cookie 名（不含值） */
  matchedCookies?: string[]
  detail?: string
}

function resolveReachPartition(spaceId?: string): string {
  const raw = getBrowserEnvironmentService().getPartitionForSpace(spaceId ?? '')
  return raw.startsWith('persist:') ? raw : `persist:${raw}`
}

/**
 * 轻量探登录态：读 Electron partition 的 session cookies（doctor 与 run 共用）。
 * 失败标 unknown，禁止把「未确认」谎称为 anonymous 的唯一依据（loggedIn 仍 false，但 status 区分）。
 */
async function probeLoginSession(
  adapter: PlatformAdapter | undefined,
  body: any,
): Promise<LoginProbeResult> {
  if (!adapter) {
    return { status: 'skipped', loggedIn: false, detail: 'no adapter' }
  }

  const hints = PLATFORM_LOGIN_COOKIE_HINTS[adapter.id]
  if (!hints) {
    return {
      status: 'skipped',
      loggedIn: false,
      detail: `平台 ${adapter.id} 无 cookie 登录线索（多为公开站）`,
    }
  }

  const spaceId = str(body, 'spaceId', 'space_id') || getCLISpaceId() || undefined
  const probeUrl = hints.probeUrls[0]
  try {
    const partition = resolveReachPartition(spaceId)
    const ses = electronSession.fromPartition(partition)
    const present = new Set<string>()
    for (const url of hints.probeUrls) {
      const cookies = await ses.cookies.get({ url })
      for (const c of cookies) present.add(c.name)
    }
    const matchedCookies = hints.cookieNames.filter((name) => present.has(name))
    const loggedIn = matchedCookies.length > 0
    return {
      status: 'ok',
      loggedIn,
      probeUrl,
      matchedCookies,
      detail: loggedIn
        ? `session cookies 命中: ${matchedCookies.join(',')}`
        : `session cookies 未命中 [${hints.cookieNames.join(',')}]（partition=${partition}）`,
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    log.warn('doctor 登录探测失败', { platform: adapter.id, detail })
    return {
      status: 'unknown',
      loggedIn: false,
      probeUrl,
      detail,
    }
  }
}

function str(body: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = body?.[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

function intOf(body: any, ...keys: string[]): number | undefined {
  for (const k of keys) {
    const v = body?.[k]
    const n = typeof v === 'number' ? v : Number(v)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return undefined
}

function boolOf(body: any, ...keys: string[]): boolean {
  for (const k of keys) {
    if (body?.[k] === true || body?.[k] === 'true') return true
  }
  return false
}

/**
 * 构造选路探测事实。桌面 Electron 单运行时。
 * requiresLogin 仅表示「调用方显式要 --use-login」；该开关仍被产品闸门拒掉。
 * loggedIn 来自分区 cookie 探测，用于 doctor note / run 结果的 authContext。
 */
function buildProbe(
  registry: AdapterRegistry,
  platform: string,
  verb: Verb | undefined,
  useLogin: boolean,
  loggedIn = false,
): PlatformProbe {
  const adapter = registry.get(platform)
  return {
    platform,
    adapterPresent: !!adapter,
    supportsRequestedVerb: verb ? registry.supports(platform, verb) : true,
    runtimeAvailable: ['electron'],
    loggedIn,
    requiresLogin: useLogin,
    proxyConfigured: false,
    loginHint: adapter?.session.loginHint,
  }
}

/** 从 CLI body 抽出用户附加的排序/筛选，供选路闸门对表（已建模种类）。 */
function requestedSearchConstraintsFromBody(body: any): RequestedSearchConstraint[] {
  const out: RequestedSearchConstraint[] = []
  const sort = str(body, 'sort')
  if (sort) out.push({ kind: 'sort', key: sort })
  const filter = str(body, 'filter')
  if (filter) {
    for (const part of filter.split(',')) {
      const key = part.trim()
      if (key) out.push({ kind: 'filter', key })
    }
  }
  const filters = body?.filters
  if (Array.isArray(filters)) {
    for (const f of filters) {
      if (typeof f === 'string' && f.trim()) out.push({ kind: 'filter', key: f.trim() })
    }
  }
  return out
}

function authContextFromProbe(loginProbe: LoginProbeResult): AuthContext {
  return loginProbe.loggedIn ? 'logged-in' : 'anonymous'
}

async function handleDoctor(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const platform = str(body, 'platform')
  if (!platform) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 platform 参数', {
      suggestions: ['示例: tabtin reach doctor --platform xiaohongshu'],
    }))
    return
  }
  const registry = getRegistry()
  const verb = str(body, 'verb') as Verb | undefined
  const useLogin = boolOf(body, 'useLogin', 'use_login')
  const adapter = registry.get(platform)
  const loginProbe = await probeLoginSession(adapter, body)
  const probe = buildProbe(registry, platform, verb, useLogin, loginProbe.loggedIn)
  const choice = selectBackend(probe)
  const searchConstraints = resolveSearchConstraints(adapter)
  const summaryBase = describeChoice(platform, verb ?? ('search' as Verb), choice)
  const summary =
    loginProbe.status === 'unknown'
      ? `${summaryBase}（登录态未确认：${loginProbe.detail ?? 'probe unknown'}）`
      : summaryBase
  sendJSON(res, 200, okResponse({
    platform,
    verb: verb ?? null,
    choice,
    summary,
    loginProbe,
    // 已建模约束（sort/filter）对不上时 /reach/search 会 400；价区/页码未建模本轮不拦
    searchConstraints,
    routingGate: {
      rule:
        '用户意图含已声明的排序/筛选时，须落在 searchConstraints 内才可 reach search；' +
        '有缺口则 /reach/search 直接 400，改 browser 或 browser-collect，禁止默认序交差。',
      defaultSortOnly: searchConstraints.sorts.length === 0,
      enforcedOnSearch: true,
    },
    ...(adapter
      ? {
          capabilities: adapter.capabilities,
          authLevel: adapter.authLevel,
          domains: adapter.domains,
        }
      : {}),
    availablePlatforms: registry.list().map((a) => a.id),
  }))
}

async function handleRun(
  verbSeg: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const platform = str(body, 'platform')
  if (!platform) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 platform 参数', {
      suggestions: [`示例: tabtin reach ${verbSeg} --platform xiaohongshu --query "..."`],
    }))
    return
  }
  const verb = verbSeg as Verb
  const registry = getRegistry()
  const adapter = registry.get(platform)
  const useLogin = boolOf(body, 'useLogin', 'use_login')

  // 显式登录态批量采集开关未开放（≠ 禁止复用 TabWeb 已有会话）。
  if (useLogin) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR',
      '登录态批量采集开关尚未开放。请去掉 --use-login。' +
      '若 TabWeb 已登录该站，reach 会复用分区会话；结果 authContext 反映实际会话。', {
      detail: { decision: 'login_batch_collect_disabled' },
    }))
    return
  }

  if (!adapter) {
    sendJSON(res, 404, errorResponse('VALIDATION_ERROR', `no adapter for "${platform}"`))
    return
  }
  const handler = adapter.verbs[verb]
  if (!handler) {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR',
      `adapter "${platform}" 不支持动词 "${verb}"`, {
      detail: { capabilities: adapter.capabilities },
    }))
    return
  }

  // search：仅对已建模的 sort/filter 硬拦（价区/页码未建模，本轮不拦）。
  if (verb === 'search') {
    const routing = decideSearchRouting(adapter, requestedSearchConstraintsFromBody(body))
    if (!routing.allowReach) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', routing.hint, {
        detail: {
          unmatched: routing.unmatched,
          searchConstraints: routing.searchConstraints,
        },
      }))
      return
    }
  }

  const loginProbe = await probeLoginSession(adapter, body)
  const authContext = authContextFromProbe(loginProbe)

  const probe = buildProbe(registry, platform, verb, useLogin, loginProbe.loggedIn)
  const choice: BackendChoice = selectBackend(probe)
  if (choice.status === 'unavailable') {
    sendJSON(res, 400, errorResponse('VALIDATION_ERROR', choice.reason, {
      detail: { hint: choice.hint, availablePlatforms: registry.list().map((a) => a.id) },
    }))
    return
  }

  const executor = getCLIActionExecutor()
  if (!executor) {
    sendJSON(res, 503, errorResponse('INTERNAL_ERROR', 'TabTin 界面尚未就绪（浏览器执行器未初始化）', {
      retryable: true,
    }))
    return
  }

  const spaceId = str(body, 'spaceId', 'space_id') || getCLISpaceId() || undefined
  const crawlspaceId = str(body, 'crawlspaceId', 'crawlspace_id') || getCLICrawlspaceId() || undefined
  const requestedTabId = str(body, 'tabId', 'tab_id')
  const tabId = requestedTabId
    ? await resolveTabId(requestedTabId, { spaceId, crawlspaceId })
    : undefined

  const port = createElectronBrowserPort(executor, { spaceId, crawlspaceId })
  const ctx: RunContext = {
    browser: port,
    authContext,
    ...(tabId ? { tabId } : {}),
    log: (msg, meta) => log.info(msg, meta),
  }

  try {
    const items: NormalizedItem[] = await handler.run(ctx, {
      query: str(body, 'query'),
      url: str(body, 'url'),
      target: str(body, 'target'),
      limit: intOf(body, 'limit'),
      sort: str(body, 'sort'),
      min_price: str(body, 'minPrice', 'min_price') ?? (body?.minPrice != null ? String(body.minPrice) : undefined),
      max_price: str(body, 'maxPrice', 'max_price') ?? (body?.maxPrice != null ? String(body.maxPrice) : undefined),
      page: intOf(body, 'page'),
      filter: str(body, 'filter'),
      filters: body?.filters,
    })
    sendJSON(res, 200, okResponse({
      platform,
      verb,
      authContext: ctx.authContext,
      loginProbe,
      extraction: handler.extraction,
      count: items.length,
      items,
    }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('reach run 失败', { platform, verb, message })
    sendJSON(res, 500, errorResponse('INTERNAL_ERROR', message, {
      detail: { platform, verb },
    }))
  }
}

export async function handleReachRoute(
  url: string,
  _method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const route = url.replace(/^\/reach/, '')
  const seg = route.replace(/^\//, '').split('/')[0] ?? ''

  if (seg === 'doctor') {
    await handleDoctor(body, res, sendJSON)
    return
  }
  if (seg) {
    await handleRun(seg, body, res, sendJSON)
    return
  }
  sendJSON(res, 404, errorResponse('UNKNOWN_ROUTE', `未知的 reach 命令: ${url}`, {
    suggestions: [
      'tabtin reach doctor --platform xiaohongshu',
      'tabtin reach search --platform xiaohongshu --query "..."',
    ],
  }))
}
