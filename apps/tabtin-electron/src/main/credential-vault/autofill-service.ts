/**
 * AutofillService — dom-ready 后的自动填充编排层。
 *
 * 流程：
 * 1. 检测页面是否有登录表单
 * 2. 提取当前页面域名
 * 3. 匹配后端存储的凭据
 * 4. 通知渲染进程展示选择器 Overlay / 或直接静默填充
 * 5. 接收用户选择，获取明文密码并填充
 *
 * Wave 3 G2 新增：
 *   - `onPasswordSubmitted(tabId, payload)`：接收 preload 转发的密码捕获事件，
 *     验证登录成功 → 三模式决策 → 通知渲染层弹保存条；
 *   - `verifyLoginSuccess(tabId, originalUrl)`：等 1.5s 检查 URL 变化 + 当前
 *     页无密码框，过滤"输错密码仍在登录页"的误触发；
 *   - `checkDomainBlacklist(domain)`：缓存 5min 的黑名单查询，避免对每次密码
 *     提交都打一次后端。
 */

import { dialog, BrowserWindow, app, ipcMain } from 'electron'
import type { WebContents, IpcMainInvokeEvent } from 'electron'
import { URL } from 'url'
import http from 'http'
import https from 'https'
import { createHash } from 'node:crypto'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { getViewFactory } from '../view-factory'
import {
  detectLoginForm,
  fillLoginForm,
  notifyRendererAutofillSuggestion,
  clearRendererAutofillSuggestion,
  installPasswordCaptureScript,
  submitLoginForm,
} from './autofill-detector'
import type { FormDetectResult } from './autofill-detector'
import { TokenManager } from '../auth'
import { guardedHandle } from '../utils/guarded-handle'
import { API_BASE_URL } from '../config/api'
import { joinApiPath } from '@tabtin/config'
import { getMainWindow } from '../window-manager'
import { getModalWindowManager } from '../overlay/overlay-window-manager'
import { registerAutofillDomReadyHandler } from './autofill-dom-ready-port'
import { createLogger } from '../logger'

const log = createLogger('AutofillService')

// autofill 触发链路诊断点。只记 host / 布尔 / 计数，绝不记 URL query /
// 用户名 / 密码。debug 级别，排查"重开登录页不弹自动填充"时打开 verbose 即可见。
function traceAutofill(msg: string, data?: Record<string, unknown>): void {
  log.debug('[autofill] ' + msg, data ?? {})
}

type CredentialMatch = {
  id: string
  url: string
  username: string
  masked_password: string
}

// ════════════════════════════════════════════════════════════════════
// Wave 4 H1：View 元数据分支 — 区分"前台用户 view" vs "Agent 后台 view"
// ════════════════════════════════════════════════════════════════════

/**
 * 一个 view 的"是否 Agent 后台 view"判断信号集合。
 *
 * 来源：``ViewFactory.getViewState(tabId).config.{displayMode,profile,runId,
 * showInSidebar,metadata}``。autofill-service 不直接 import ViewFactory（避免
 * 循环依赖 + 单测难度），而是接受外部注入一个 resolver 函数。
 *
 * 在 ``initAutofillService`` 默认实现中，resolver 会调 ``getViewFactory()``
 * 查询；测试 / E2E 走 ``setViewClassificationFn`` 注入 mock。
 */
export interface ViewClassification {
  /** 'hidden' 表示屏幕外 view（Agent 后台任务的关键标志）；'embedded' 是用户能看到的标签 */
  displayMode?: 'hidden' | 'embedded' | 'new-window'
  /** profiles.ts 注册的预设；'background-task' 是 Agent 后台任务专用 */
  profile?: 'user-tab' | 'agent-workspace' | 'background-task' | 'temporary-preview'
  /** 关联的 Agent run ID — 有 runId 表示该 view 由 Agent 创建（而不是用户） */
  runId?: string
  /** 是否在侧边栏显示标签（用户可见路径的强信号） */
  showInSidebar?: boolean
  /** 关联的 spaceId */
  spaceId?: string
}

let viewClassificationFn: ((tabId: string) => ViewClassification | null) | null = null

/**
 * 注入"按 tabId 反查 view 元数据"的解析器。
 *
 * - **生产**：``initAutofillService`` 装一个调 ``getViewFactory().getViewState()``
 *   的实现；
 * - **单测 / E2E**：直接 ``setViewClassificationFn`` 喂 mock。
 *
 * 传 ``null`` 清空——清空后所有 view 都被视为前台用户 view（保守降级，
 * 不破坏 Wave 3 行为）。
 */
export function setViewClassificationFn(
  fn: ((tabId: string) => ViewClassification | null) | null,
): void {
  viewClassificationFn = fn
}

/**
 * 判断一个 view 是不是 Agent 后台 view（Wave 4 H1 核心信号）。
 *
 * **三视角 Review 视角 1 P1 发现 5 自修**：
 *   原本第二条兜底信号是 ``displayMode === 'hidden' AND runId`` —— 但
 *   ``RunSessionManager.openTab`` 给 ``viewFactory.createView`` 的 displayMode
 *   默认值是 ``options.displayMode ?? 'hidden'``（强制 hidden 兜底）。Agent 调
 *   ``open_tab`` 创建的 view 几乎全部满足"hidden + runId"，**无论 profile 是
 *   ``agent-workspace`` 还是 ``background-task``**——这与"agent-workspace 用户
 *   能看到，仍走前台 overlay"的设计意图相反。
 *
 *   修复：第二条信号增加 profile 排除项——``profile !== 'agent-workspace'`` AND
 *   ``profile !== 'temporary-preview'``。仅在 profile 缺失（unknown）或明确表示
 *   后台用途时才走 Agent 后台 view 自动 fill+submit 路径。
 *
 * 综合判断（满足任一条件即 true）：
 *   1. ``profile === 'background-task'``：``profiles.ts`` 注册的 Agent 后台
 *      任务专用 profile（``displayMode='hidden'`` + ``autoClose=true`` +
 *      ``persistent=false``），最权威的强信号。
 *   2. ``displayMode === 'hidden'`` AND ``runId`` 存在 AND profile 不是
 *      ``agent-workspace`` 或 ``temporary-preview``：屏幕外 + Agent run 上下文
 *      + 不是用户能看到的 profile = Agent 后台任务兜底信号。
 *
 * **不**采用的信号（避免误伤）：
 *   - 单独 ``displayMode === 'hidden'``：用户可能临时把标签隐藏（如最小化）；
 *   - ``profile === 'agent-workspace'``：默认 ``displayMode='embedded'`` +
 *     ``showInSidebar=false`` —— Agent 工作区，**用户能看到**（在
 *     CrawlspaceWorkspace 里），仍走前台 overlay 路径；
 *   - ``profile === 'temporary-preview'``：默认 ``embedded`` +
 *     ``showInSidebar=true``，临时预览，用户能看到，仍走前台 overlay。
 *
 * 返回 false 时走 Wave 3 现有 overlay 路径（用户可见，弹建议）。
 */
function isAgentBackgroundView(c: ViewClassification | null): boolean {
  if (!c) return false
  if (c.profile === 'background-task') return true
  if (
    c.displayMode === 'hidden' &&
    c.runId &&
    c.profile !== 'agent-workspace' &&
    c.profile !== 'temporary-preview'
  ) {
    return true
  }
  return false
}

export function __isAgentBackgroundViewForTest(c: ViewClassification | null): boolean {
  return isAgentBackgroundView(c)
}

/**
 * Wave 3 G2：保存提示模式。
 *
 * - `save`：全新凭据（域名 + username 都没存过）→ "保存 example.com 的密码？"
 * - `update`：同一 (域名, username) 已存在但密码变了 → "更新 example.com 的密码？"
 * - `new-account`：同域名已有其它 username → "保存为 example.com 的新账号？"
 *
 * 完全一致（域名+username+password）会在 `onPasswordSubmitted` 内被静默跳过，
 * 不会出现在 `SavePromptMode` 里。
 */
export type SavePromptMode = 'save' | 'update' | 'new-account'

export interface SavePromptPayload {
  tabId: string
  mode: SavePromptMode
  domain: string
  url: string
  username: string
  /** Update 模式下携带 credentialId，便于渲染层 confirm 时直接 PUT */
  credentialId?: string
  /** 仅 new-account 模式下携带，提示用户该域名下已有的其它 username 列表（脱敏前缀展示用） */
  existingUsernames?: string[]
}

let credentialMatchFn: ((domain: string) => Promise<CredentialMatch[]>) | null = null
let credentialRevealFn: ((credentialId: string) => Promise<{ url: string; username: string; password: string } | null>) | null = null

/**
 * Wave 3 G2 测试 hook：autofill-reveal 的"非交互"内部版本（不弹 confirm dialog）。
 *
 * 为什么和 `credentialRevealFn` 分开：用户驱动的 autofill 选择需要 dialog 二次
 * 确认（避免后台脚本悄悄拿密码）；保存提示场景下，主进程**只是想比对**当前
 * 提交的密码与已存密码是否一致——这是系统内部决策（save vs update vs skip），
 * 不应弹 dialog 打扰用户。
 *
 * 默认实现走后端 `/website/{id}/autofill-reveal` 端点，与 `credentialRevealFn`
 * 共用 RATE LIMIT 配额。
 *
 * **Wave 4 三视角 Review 视角 3 P2 发现 3 自修（DRY 真·收尾）**：
 *   `revealForAutofillWithoutDialogFn` 与本变量在 ``initAutofillService`` 里被注
 *   入完全相同的 closure。两个全局变量本质等价，只是为了让单测能独立 mock 任
 *   一路径——但生产路径永远等同。
 *
 *   保留双 setter 的成本：每加一处用法点都要决定调哪个 setter，已被视角 3 标
 *   记为反模式残骸。本次迭代**不**直接拆掉双 setter（会 break 现有 17 个 wave4
 *   单测的 mock 注入语义），而是改写 ``initAutofillService`` 默认实现到一个共
 *   享的 ``getNonInteractivePlaintextFetcher()`` getter，确保生产路径 SSoT；
 *   测试侧仍然可以两条路径独立 mock。Wave 5 setter pattern 整体重构时一并清。
 */
let credentialFetchPlaintextFn:
  | ((credentialId: string) => Promise<{ url: string; username: string; password: string } | null>)
  | null = null

const webContentsMap = new Map<string, WebContents>()

/**
 * Wave 3 修正版 真问题 2（SPA 登录被误判为失败）：in-page navigation 跟踪。
 *
 * 背景：很多现代登录页（accounts.google.com、Notion、Linear 等）登录成功后
 * 用 `history.pushState` 切换到 dashboard 视图，**`webContents.getURL()` 字符串
 * 不变**（pushState 不触发 main-frame navigation 事件），导致 verifyLoginSuccess
 * 用 `currentUrl === originalUrl` 判失败 → 真登录成功也不弹保存条。
 *
 * 修复：onViewDomReady 时为每个 webContents 挂 `did-navigate-in-page` 监听，
 * 把每次 in-page navigation 的时间戳记入此 map。verifyLoginSuccess 时检查
 * "form submit 之后是否发生过 in-page navigation"——如果有，**也算 URL 变化**。
 *
 * 此 map 与 webContentsMap 的生命周期绑定（webContents.once('destroyed')
 * 同时清两边）；为简单起见用 tabId 作 key（与 webContentsMap 一致）。
 */
interface InPageNavRecord {
  /** 最近一次 did-navigate-in-page 的时间戳（Date.now()），未发生过则为 0 */
  lastInPageNavAt: number
}
const inPageNavMap = new Map<string, InPageNavRecord>()

/**
 * Wave 3 修正版 Review 视角 3 P0 自修：精准摘除 did-navigate-in-page listener。
 *
 * **问题**：旧实现用 `webContents.removeAllListeners('did-navigate-in-page')`
 * 摘旧 wc 的监听——但 ResourceDetectionService / ViewStateRegistryListeners /
 * crawl-view-webcontents-events 也在同一事件上挂了监听。`removeAllListeners`
 * 会一并摘掉，导致旧 wc 资源面板 / view 状态 / 事件总线**对该 wc 静音**。
 *
 * **修复**：保存我们自己挂的 listener 引用，按 tabId 索引，复用同一 tabId 时
 * 用 `removeListener(handler)` 精准摘掉自己那条，其他模块的不动。
 */
const inPageNavListeners = new Map<string, (...args: any[]) => void>()

/**
 * Wave 3 修正版 Review 视角 1 P1-1（升 P0）自修：按 tab + URL 去重 autofill
 * suggestion 触发。用 URL 去重而非 isFirstRegistration 去重，覆盖 about:blank
 * → 真实 URL 的 view-create 路径。
 *
 * 容量：与 webContentsMap 1:1（同一 tabId 一条记录），webContents destroyed 时
 * 同步清理。
 */
const lastSuggestUrlByTab = new Map<string, string>()

export function __getInPageNavRecordForTest(tabId: string): InPageNavRecord | undefined {
  return inPageNavMap.get(tabId)
}

export function __setInPageNavRecordForTest(tabId: string, lastInPageNavAt: number): void {
  inPageNavMap.set(tabId, { lastInPageNavAt })
}

/**
 * Wave 3 G2 安全设计：**密码不进 renderer**。
 *
 * 主进程在 onPasswordSubmitted 决策成功后，把待保存的密码暂存在这里（按 tabId
 * 索引），emit save-prompt 给 renderer 时**只**带 (mode, domain, url, username,
 * credentialId?)——密码字段缺席。
 *
 * 用户点"保存" → renderer 发 `credential-vault:save-confirm { tabId }` →
 * 主进程从 `pendingSavePasswords` 取出密码 + 调后端 → 立即从 map 删除。
 *
 * 这样密码全程不出主进程内存，符合 PRD 8.1 安全边界 "密码明文不进入渲染进程"。
 *
 * 自动过期：3min 内用户没操作就清掉（避免长驻内存）。
 */
interface PendingSaveEntry {
  password: string
  url: string
  username: string
  domain: string
  mode: SavePromptMode
  credentialId?: string
  expiresAt: number
}
const pendingSavePasswords = new Map<string, PendingSaveEntry>()
const PENDING_SAVE_TTL_MS = 3 * 60 * 1000

/**
 * Wave 3 修正版 Review 视角 1 P0 + 视角 2 P0 自修：跨 tab/跨 domain 密码去重。
 *
 * **解决 2 个真问题**：
 *   1. OAuth 多跳：用户在 accounts.google.com 输 Google 密码 → 跳第三方
 *      callback。第三方页若也命中 verifyLoginSuccess，会弹"保存
 *      第三方.com 密码"——但用户输的是 Google 密码！
 *   2. Agent autofill 自动 click 登录：fillLoginForm 把已存凭据填入 →
 *      Agent click 触发 PASSWORD_CAPTURE_SCRIPT click 信号 → 走
 *      onPasswordSubmitted。如果 credentialFetchPlaintextFn 失败拿不到现有
 *      密码 → 走 mode='update' 静默改写。
 *
 * **机制**：
 *   - emitSavePrompt（或 Agent autofill 的 fillLoginForm）调用时记 (passwordHash, ts)
 *   - onPasswordSubmitted 入口：若同 passwordHash 在 30s 内已经有过提示/填充
 *     **且 domain 不同** → 跳过（视为 OAuth 中转 / Agent autofill 二次触发）
 *   - 用 SHA-256 前 16 字节 hex 作为 hash key，密码本身不留
 */
interface RecentSubmitRecord {
  passwordHashShort: string
  domain: string
  at: number
}
const recentSubmits: RecentSubmitRecord[] = []
const RECENT_SUBMIT_WINDOW_MS = 30 * 1000

function hashPasswordShort(password: string): string {
  // 仅留前 16 字节 hex，足以做相等性判定，不可逆
  return createHash('sha256').update(password).digest('hex').slice(0, 32)
}

function pruneRecentSubmits(now: number): void {
  while (recentSubmits.length > 0 && now - recentSubmits[0].at > RECENT_SUBMIT_WINDOW_MS) {
    recentSubmits.shift()
  }
}

function recordRecentSubmit(passwordHashShort: string, domain: string): void {
  const now = Date.now()
  pruneRecentSubmits(now)
  recentSubmits.push({ passwordHashShort, domain, at: now })
}

/**
 * 检查同密码在窗口内是否已经被处理过（无论 domain 异同）。
 *
 * - **跨 domain 命中**（OAuth 多跳）：用户在 google.com 输密码，跳第三方
 *   callback 后第三方页若也 capture 同密码 → 命中，跳过保存提示
 * - **同 domain 命中**（autofill 回声 / 用户重复点登录）：autofill 把已存
 *   密码填入页面后，Agent click 登录按钮触发 capture 上报相同密码 →
 *   命中，跳过。同 domain 用户 30s 内手动改密码并重输是同 domain 不同
 *   hash，**不**会被这条逻辑误伤。
 */
function isRecentlySubmittedDuplicate(passwordHashShort: string): boolean {
  const now = Date.now()
  pruneRecentSubmits(now)
  return recentSubmits.some((r) => r.passwordHashShort === passwordHashShort)
}

export function __clearRecentSubmitsForTest(): void {
  recentSubmits.length = 0
}

function scheduleClearPending(tabId: string): void {
  setTimeout(() => {
    const entry = pendingSavePasswords.get(tabId)
    if (entry && entry.expiresAt <= Date.now()) {
      pendingSavePasswords.delete(tabId)
    }
  }, PENDING_SAVE_TTL_MS + 100)
}

export function __clearPendingSavePasswordsForTest(): void {
  pendingSavePasswords.clear()
}

export function setCredentialMatchFn(fn: (domain: string) => Promise<CredentialMatch[]>): void {
  credentialMatchFn = fn
}

export function setCredentialRevealFn(fn: (credentialId: string) => Promise<{ url: string; username: string; password: string } | null>): void {
  credentialRevealFn = fn
}

/**
 * 测试和 G2 内部使用：注入"无交互"的明文获取函数。
 * 默认实现在 `initAutofillService` 中通过 `djangoPost` 直接拉，不弹 dialog。
 */
export function setCredentialFetchPlaintextFn(
  fn: (credentialId: string) => Promise<{ url: string; username: string; password: string } | null>,
): void {
  credentialFetchPlaintextFn = fn
}

/**
 * 测试 hook：注入 main window emit 函数（生产走 getMainWindow().webContents.send）。
 */
type SavePromptEmitter = (payload: SavePromptPayload) => void
let savePromptEmitter: SavePromptEmitter | null = null
export function setSavePromptEmitter(fn: SavePromptEmitter | null): void {
  savePromptEmitter = fn
}

/**
 * 测试 hook：注入 autofill suggestion overlay emitter。
 *
 * 默认走 ``notifyRendererAutofillSuggestion``（autofill-detector）— 后者最终
 * 调 ``getMainWindow().webContents.send('credential-vault:autofill-suggest', ...)``。
 *
 * 单测 / E2E 注入这个 emitter 来：
 *   - 验证"前台 view 收到 overlay 触发"（W4-E 场景）；
 *   - 验证"Agent 后台 view 不收到 overlay"（W4-A/B/C/D 场景）；
 *
 * 传 ``null`` 恢复默认行为。
 *
 * 安全：emitter 收到的 ``credentials`` 数组是脱敏后的（masked_password='****'），
 * 不含明文密码——本 hook 不影响 Wave 4 安全不变量。
 */
type OverlayEmitterPayload = {
  tabId: string
  credentials: Array<{ id: string; url: string; username: string; masked_password: string }>
  formInfo: { hasPassword: boolean; hasUsername: boolean; passwordCount: number; domain: string }
}
type OverlayEmitter = (payload: OverlayEmitterPayload) => void
let overlayEmitter: OverlayEmitter | null = null
export function setOverlayEmitter(fn: OverlayEmitter | null): void {
  overlayEmitter = fn
}

/**
 * 测试 hook：注入 webContentsMap 项（生产走 onViewDomReady 自动注册）。
 *
 * **导出原因**：单测里要直接喂 webContents mock 给 `onPasswordSubmitted`，
 * 不走完整 onViewDomReady → credentialMatchFn → notifyRendererAutofillSuggestion
 * 链路。
 */
export function __setWebContentsForTest(tabId: string, wc: WebContents): void {
  webContentsMap.set(tabId, wc)
}

export function __clearAllWebContentsForTest(): void {
  webContentsMap.clear()
  inPageNavMap.clear()
  lastSuggestUrlByTab.clear()
  inPageNavListeners.clear()
}

function extractDomain(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Wave 4 三视角 Review 视角 3 P2 发现 6 自修：抽 ``recordRecentSubmit`` 三处
 * 调用的 domain 取法到统一兜底链。
 *
 * **Why this exists**：
 *   修复前三处 ``recordRecentSubmit`` 调用各有 fallback 链：
 *     - ``runAgentAutofill``：``extractDomain(wc.getURL()) || domain``
 *     - ``stashPendingAndEmit``：``args.domain``（无兜底）
 *     - ``credential-vault:autofill-select``：``extractDomain(wc.getURL()) || extractDomain(credential.url) || ''``
 *
 *   ``isRecentlySubmittedDuplicate`` 只看 hash 不看 domain（Wave 3 已知 trade-off），
 *   但诊断日志会 log ``prevDomain``——三处不一致让排查"为什么这条 dedup 命中了"
 *   时看到的字符串各不相同。
 *
 * **统一规则**：
 *   1. 首选 ``wc.getURL()`` 的 hostname（最权威——这是用户/Agent 当前真在交互的页面）
 *   2. 次选传入的 ``hintDomain``（onPasswordSubmitted 入参 / dom-ready 时算的 domain）
 *   3. 末选 ``credentialUrl`` 的 hostname（凭据库存的 URL 兜底，用于 wc 已销毁场景）
 *   4. 全失败返回 ``null`` —— 调用方判 null 决定是否 record（不再传空字符串）
 */
function resolveDedupDomain(
  webContents: WebContents | null,
  hints: { hintDomain?: string; credentialUrl?: string } = {},
): string | null {
  if (webContents && !webContents.isDestroyed()) {
    try {
      const url = webContents.getURL()
      const d = extractDomain(url)
      if (d) return d
    } catch {
      // wc.getURL() 在某些边界状态会抛——降级走 hint
    }
  }
  if (hints.hintDomain) return hints.hintDomain.toLowerCase()
  if (hints.credentialUrl) {
    const d = extractDomain(hints.credentialUrl)
    if (d) return d
  }
  return null
}

/**
 * 判定两个 hostname 是否兼容（同主域 / 子域关系）。
 *
 * Wave 3 P0 视角 1#2 投毒兜底：page postMessage 自报 url 经过 preload
 * 转发后，主进程不能简单等值比较——SPA 跳子路径（path 变 host 不变）
 * 是合法场景，但跨主域（例如 page 跑在 evil.com 但报 victim-bank.com）必须拒绝。
 *
 * 容忍 *.example.com ↔ example.com 一类的关系（两侧任一为另一侧后缀）。
 */
function domainsCompatible(a: string, b: string): boolean {
  if (!a || !b) return false
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  if (la === lb) return true
  return la.endsWith('.' + lb) || lb.endsWith('.' + la)
}

/**
 * 在 dom-ready 后调用，检测并触发自动填充流程，同时注入密码捕获脚本。
 *
 * Wave 3 G1 改动：
 *   - 所有 http(s) 页面都注入 `PASSWORD_CAPTURE_SCRIPT`（不论是否有匹配凭据）
 *     —— 保存提示是"积累新凭据"的入口，必须对**没匹配**的页面也起效。
 *   - **about:blank / chrome:// / devtools:// 也登记 webContentsMap**（Wave 3
 *     Review V1-#4）：否则 view 第一次 load 是 about:blank 被 early return →
 *     真实 URL navigate 后 password-captured handler 反查不到 sender 兜底
 *     成"unknown"，破坏 sender 校验前提。登记不会注入脚本（脚本 navigate 后
 *     dom-ready 重新跑），所以是安全的"占位"。
 *
 * Wave 3 P0 修复（视角 1+3）：
 *   - **重复挂 destroyed 监听 → 加幂等**（视角 1 #3）：同一 webContents 多
 *     次 dom-ready（SPA 路由）下不再叠加 listener。
 *
 * Wave 3 修正版 真问题 1（同 tab 多文档导航注入丢失）：
 *   - 关键症状：OAuth 回调 / 跳转登录页 / 多跳登录场景，**同一 webContents
 *     的第二次 dom-ready 整段被 early return 短路** → `installPasswordCaptureScript`
 *     不再被调用。但 `executeJavaScript` 注入的脚本绑在 page document 上，
 *     新文档加载时旧 document 销毁，脚本随之消失 → **新文档完全没有捕获能力**。
 *   - 修复策略：**注册 webContents** 仍然首次幂等（避免重复挂 destroyed
 *     监听 + 复用 detectLoginForm 结果），但 **`installPasswordCaptureScript`
 *     每次 dom-ready 都调用**。脚本本身的 `__tabtinPasswordCaptureInstalled`
 *     幂等保护：旧文档跳过、新文档实装。
 *   - 这同时解决 SPA 路由变化场景（虽然 SPA pushState 不触发 dom-ready，
 *     但很多"SPA"实际是 server-side rendering + history.pushState 组合，
 *     部分跳转还是触发 dom-ready）。
 */
/**
 * 登录表单检测重试计时。
 *
 * 为什么需要重试：现代 SPA 登录页（知乎 / 大量 React/Vue 站点）的登录表单是
 * `dom-ready` **之后**由 JS 异步渲染的——只在 dom-ready 检测一次必然扑空
 * （`detectLoginForm` 返回 null，密码框还没进 DOM）。这里在 dom-ready 后开一个
 * 短时间窗口轮询检测，一旦密码框出现就触发自动填充建议，同 UX（卡片仍在页面
 * 加载后不久出现），但对 SPA 异步渲染鲁棒。
 *
 * 做成模块级可覆盖：单测通过 `__setAutofillDetectTimingForTest` 调成单次无延迟，
 * 避免真的轮询导致超时。
 */
const AUTOFILL_DETECT_DEFAULT_TIMING = {
  attempts: 12,
  intervalMs: 700,
}
let autofillDetectTiming = { ...AUTOFILL_DETECT_DEFAULT_TIMING }

export function __setAutofillDetectTimingForTest(
  t: Partial<typeof AUTOFILL_DETECT_DEFAULT_TIMING> | null,
): void {
  autofillDetectTiming = t ? { ...autofillDetectTiming, ...t } : { ...AUTOFILL_DETECT_DEFAULT_TIMING }
}

/**
 * 在 dom-ready 后的短窗口内轮询检测登录表单，覆盖 SPA 异步渲染。
 *
 * - 一旦检测到密码框（`hasPassword`）立即返回；
 * - webContents 销毁、或页面已导航到别的 page（按 origin+pathname 判定，忽略
 *   query/hash 抖动）→ 放弃重试，交给新页面的 dom-ready 重新走流程；
 * - 全程未检测到 → 返回 null（调用方 bail）。
 */
async function detectLoginFormWithRetry(
  webContents: WebContents,
  originalUrl: string,
): Promise<FormDetectResult | null> {
  const { attempts, intervalMs } = autofillDetectTiming
  const originalKey = computeSuggestKey(originalUrl)
  for (let i = 0; i < attempts; i++) {
    if (webContents.isDestroyed()) return null
    // 页面已换 page（真实导航）→ 停止，避免给过期页面弹建议
    if (computeSuggestKey(webContents.getURL()) !== originalKey) return null
    const info = await detectLoginForm(webContents)
    if (info && info.hasPassword) return info
    if (i < attempts - 1 && intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
  return null
}

export async function onViewDomReady(tabId: string, webContents: WebContents): Promise<void> {
  const url = webContents.getURL()

  traceAutofill('onViewDomReady entry', { tabId, host: extractDomain(url) ?? '(none)' })

  // 是否首次注册（决定是否要挂 destroyed 监听 + 跑 detectLoginForm + 触发 autofill）
  const isFirstRegistration = webContentsMap.get(tabId) !== webContents

  if (isFirstRegistration) {
    // 移除旧的（tabId 复用 → 旧 webContents 应当已 destroyed，但保险起见）
    //
    // Wave 3 修正版 Review 视角 3 P0-1 自修：旧 wc 上挂的
    // `did-navigate-in-page` listener 必须主动 removeAllListeners 摘掉，
    // 否则即便 wc 还活着但被 tabId 抢占，listener 仍会触发并写到
    // `inPageNavMap.get(tabId)`——而该 entry 现在指向**新 wc 的状态**，
    // 形成"X 的事件污染 Y 的判定" → verifyLoginSuccess 误判成功。
    const old = webContentsMap.get(tabId)
    if (old && old !== webContents) {
      // Wave 3 修正版 Review 视角 3 P0 自修：精准摘除我们自己挂的 handler，
      // **不**用 removeAllListeners——会误伤 ResourceDetectionService /
      // ViewStateRegistryListeners / crawl-view-webcontents-events 等其他
      // 订阅者，让旧 wc 在那些模块上静音。
      const oldHandler = inPageNavListeners.get(tabId)
      if (oldHandler) {
        try {
          if (!old.isDestroyed()) old.removeListener('did-navigate-in-page', oldHandler)
        } catch (err) {
          log.warn('failed to remove old did-navigate-in-page listener:', err)
        }
        inPageNavListeners.delete(tabId)
      }
      webContentsMap.delete(tabId)
    }

    // 始终登记（含 about:blank）：让 password-captured handler 的 sender 校验
    // 反查能命中合法 view，不需要 fallback。
    webContentsMap.set(tabId, webContents)
    // Wave 3 修正版 真问题 2：初始化 in-page nav 记录
    inPageNavMap.set(tabId, { lastInPageNavAt: 0 })
    webContents.once('destroyed', () => {
      if (webContentsMap.get(tabId) === webContents) {
        webContentsMap.delete(tabId)
        inPageNavMap.delete(tabId)
        lastSuggestUrlByTab.delete(tabId)
        inPageNavListeners.delete(tabId)
      }
    })
    // Wave 3 修正版 真问题 2：监听 in-page navigation。
    //
    // **触发范围（重要：不是所有 SPA 都覆盖）**：
    //   - history.pushState / replaceState（绝大多数现代框架）
    //   - location.hash 改动
    //   - 锚点跳转（<a href="#xxx">）
    //
    // **不覆盖的 SPA 已知盲区**（PRD 风险 7 + Review 视角 3 P0-2）：
    //   - 纯 fetch + innerHTML 改 DOM、**不调** history API 的极简 SPA
    //   - 内嵌 iframe 切换内容、外层 URL 不动
    //
    // 对这类盲区，`verifyLoginSuccess` 仅靠 title 变化兜底。如果业务方
    // **同时**没改 document.title（很多自建后台/admin 面板就是如此），
    // 多信号融合**全部失效** → 永远不弹保存条。这条限制在 PRD 8 风险章
    // 文档化为"已知限制"，V2 会增补 DOM mutation 信号。
    try {
      // 命名 handler 并存到 inPageNavListeners，复用 tabId 时精准摘除
      const onInPageNav = (): void => {
        const rec = inPageNavMap.get(tabId)
        if (rec) {
          rec.lastInPageNavAt = Date.now()
        } else {
          inPageNavMap.set(tabId, { lastInPageNavAt: Date.now() })
        }
      }
      inPageNavListeners.set(tabId, onInPageNav)
      webContents.on('did-navigate-in-page', onInPageNav)
    } catch (err) {
      // 老版本 Electron 或 webContents 已 destroyed → 静默；Verify 时仍走
      // URL/title/无密码框 三信号兜底
      log.warn('failed to attach did-navigate-in-page listener:', err)
    }
  }

  if (!url || url === 'about:blank' || url.startsWith('chrome://') || url.startsWith('devtools://')) {
    // 已登记 webContentsMap，但脚本注入和 autofill 匹配跳过——等真实 URL 的 dom-ready
    return
  }

  // Wave 3 修正版 真问题 1：每次 dom-ready 都重新注入捕获脚本。
  // 旧文档已有 `__tabtinPasswordCaptureInstalled` 标记 → 脚本立即 return；
  // 新文档没有标记 → 真正安装监听。这是"修复同 tab 多文档导航注入丢失"
  // 的核心动作——**不能受 isFirstRegistration 短路保护**。
  void installPasswordCaptureScript(webContents)

  // Wave 3 三视角 Review 视角 1 P0 发现 2 自修：
  //
  // 删除"二次 dom-ready 时把 lastInPageNavAt 清 0"的逻辑。原本的意图是
  // 防止 multi-doc 导航下读到旧文档的 pushState 时间戳，但 verifyLoginSuccess
  // 内部已经做时间戳比较 `navRec.lastInPageNavAt > submitTimestamp`
  // (autofill-service.ts:548-549)——比 reset 更可靠。
  //
  // 反过来 reset 会**主动吃掉**合法的"第二跳 dom-ready 之后、verify 醒来
  // 之前"那段窗口里发生的 in-page-nav 信号——例如 OAuth callback 页用
  // history.replaceState 抹掉 ?code= 参数（很常见），或新一代 SPA 的
  // soft-navigation API 在 dom-ready 后触发 in-page-nav。reset 把这些合
  // 法信号清 0 → verify 看不到 → 误判失败。
  //
  // 删掉 reset 后，verify 仍由 `lastInPageNavAt > submitTimestamp` 严格
  // 把关：早于 submit 的旧值（哪怕是上一文档残留）天然被过滤；晚于 submit
  // 的真实信号才被采信。一个时间戳判断比"reset + 时间戳判断"组合更优雅。

  // Wave 3 修正版 Review 视角 1 P1-1（升 P0）自修：
  //   旧逻辑用 `if (!isFirstRegistration) return` 做"避免重复弹 autofill suggestion"
  //   的去重——但 view-create 链路里，绝大多数 view 的第一次 dom-ready 都是
  //   `about:blank`（先 bootstrap webContents，后 loadURL 真实页面）。第二次
  //   dom-ready 是真实 URL，但 `isFirstRegistration=false` 直接 return →
  //   **新建 view 永远拿不到 autofill suggestion**，PRD Story 2 "用户在
  //   TabWeb 登录已存凭据网站，弹自动填充" 在 view-create 路径下完全失效。
  //
  //   修复：用 `lastSuggestUrlByTab` 做按 URL 去重——仅当本 tab 上一次跑
  //   suggestion 用的不是当前 URL 时才再触发，about:blank → 真实 URL 跳转
  //   会被识别为不同 URL 从而进 suggestion；同 URL 多次 dom-ready 仍去重。
  //
  // Wave 3 三视角 Review 视角 3 P1 发现 1 自修：
  //   去重 key 改为 `origin + pathname`（去掉 query/hash）。原本用完整 URL，
  //   query string 不同会被当成不同 URL 重复弹 overlay——例如 SSO 跳转链
  //   `?redirect_uri=...`、登录失败 `?error=...`、不同入口 `?ref=...` 都会
  //   每次重新触发 suggestion，骚扰用户。
  const traceHost = extractDomain(url) ?? '(none)'
  if (!credentialMatchFn) {
    traceAutofill('bail: credentialMatchFn 未初始化', { host: traceHost })
    return
  }
  const suggestKey = computeSuggestKey(url)
  const prevSuggestKey = lastSuggestUrlByTab.get(tabId)
  if (prevSuggestKey === suggestKey) {
    traceAutofill('bail: 同 page 去重（本 tab 已跑过 suggestion）', { host: traceHost })
    return
  }
  // 本 tab 之前弹过建议、现在换到了别的 page（真实跳转）→ 先清掉可能残留在角落
  // 的旧卡片（用户没在提示上操作、直接手动登录导航走的场景）。随后若新页命中
  // 登录表单+凭据会重新弹；否则卡片保持已清除。
  if (prevSuggestKey !== undefined) {
    clearRendererAutofillSuggestion(tabId)
  }

  const formInfo = await detectLoginFormWithRetry(webContents, url)
  if (!formInfo || !formInfo.hasPassword) {
    traceAutofill('bail: 短窗口轮询后仍没检测到密码框', { host: traceHost, formInfo })
    return
  }

  const domain = extractDomain(url)
  if (!domain) return
  traceAutofill('检测到登录表单，开始匹配凭据', { domain, formInfo })

  try {
    const matches = await credentialMatchFn(domain)
    traceAutofill('凭据匹配结果', { domain, matchCount: matches.length })
    if (matches.length === 0) return

    // ── Wave 4 H1：分流——Agent 后台 view 走"无 dialog 自动 fill+submit"路径 ──
    //
    // 判断"Agent 后台 view"信号（综合）：
    //   - profile=background-task（Agent 后台任务专用 profile）
    //   - displayMode=hidden + runId 存在（屏幕外 + 有 Agent 上下文）
    //
    // 命中 Agent 后台 view：
    //   - **不**调 notifyRendererAutofillSuggestion（不弹 overlay 给用户）
    //   - 多匹配时按 last_used_at DESC 取**第一条**（PD-10）—— 后端 /website/match
    //     已经按 last_used_at 倒序排序，前端只取 matches[0]
    //   - 调内部 ``revealForAutofillWithoutDialog``（不弹 dialog 二次确认）
    //   - fill 成功后立刻 ``submitLoginForm``（自动 click 登录按钮）
    //   - **同步 ``recordRecentSubmit``**（Wave 3 独立质疑 P1 #13 防回声）
    //
    // 命中前台用户 view：保留 Wave 3 行为，emit suggestion 给 renderer。
    let classification: ViewClassification | null = null
    try {
      classification = viewClassificationFn ? viewClassificationFn(tabId) : null
    } catch (err) {
      // resolver 异常不应阻塞 autofill 流程；保守降级走前台路径
      log.warn('view classification resolver failed:', err)
      classification = null
    }

    if (isAgentBackgroundView(classification)) {
      // Agent 后台 view：自动 fill + submit + 防回声
      lastSuggestUrlByTab.set(tabId, suggestKey)
      void runAgentAutofill(tabId, webContents, matches, domain, classification).catch((err) => {
        // runAgentAutofill 内部已 try/catch 每一步；这里是兜底
        log.warn('agent autofill flow crashed:', err)
      })
      return
    }

    // 前台用户 view：保留 Wave 3 overlay 行为
    traceAutofill('前台 view → 发送 autofill 建议到 modal 子窗口', {
      domain,
      matchCount: matches.length,
      via: overlayEmitter ? 'overlayEmitter' : 'notifyRendererAutofillSuggestion',
    })
    if (overlayEmitter) {
      overlayEmitter({ tabId, credentials: matches, formInfo: { ...formInfo, domain } })
    } else {
      notifyRendererAutofillSuggestion(tabId, matches, { ...formInfo, domain })
    }
    // 标记本 origin+pathname 已弹过 suggestion；下次 dom-ready 同 page 不再重复。
    // 跨文档/跨 path/跨 origin 跳转时，suggestKey 变了 → mark 不命中 → 重新触发。
    lastSuggestUrlByTab.set(tabId, suggestKey)
  } catch (error) {
    log.error('credential match failed:', error)
  }
}

registerAutofillDomReadyHandler(onViewDomReady)

// ════════════════════════════════════════════════════════════════════
// Wave 4 H2：Agent 后台 view 自动 fill+submit（"无 dialog 拉明文"路径）
// ════════════════════════════════════════════════════════════════════

/**
 * 测试 hook：注入"无交互"明文获取函数（默认实现在 initAutofillService 中调
 * ``/website/{id}/autofill-reveal`` 不弹 dialog）。
 *
 * Wave 4 关键安全约束：
 *   - **本函数返回的明文密码绝对不会进入 LLM 上下文 / IPC 消息 / 控制台日志**；
 *   - 主进程拿到密文后立即调 ``fillLoginForm`` 写入 page DOM，然后立即清栈帧；
 *   - 与 Wave 3 ``credentialFetchPlaintextFn``（onPasswordSubmitted 比对路径）
 *     共用同一后端端点（``POST /credential-vault/website/{id}/autofill-reveal``）
 *     共用 per-user 限流配额。
 */
let revealForAutofillWithoutDialogFn:
  | ((credentialId: string) => Promise<{ url: string; username: string; password: string } | null>)
  | null = null

export function setRevealForAutofillWithoutDialogFn(
  fn: ((credentialId: string) => Promise<{ url: string; username: string; password: string } | null>) | null,
): void {
  revealForAutofillWithoutDialogFn = fn
}

/**
 * Wave 5a (L-W4-4)：mark-used 注入器（与 reveal 同模式 / 同测试 hook 结构）。
 *
 * 默认实现（在 ``initAutofillService`` 中注入）走
 * ``POST /credential-vault/website/{id}/mark-used`` —— 仅在主进程
 * ``runAgentAutofill`` 走完 fill + submit + verify 全成功后调用，让后端
 * ``last_used_at`` 字段反映"真正成功的登录时刻"而非"reveal 成功的时刻"。
 *
 * 失败 / 限流：返回 false，autofill 主流程**不**因此回退已发出的成功 toast
 * （toast 已经按"用户登录已成功"语义发出；mark-used 失败属于排序展示瑕疵
 * 而非业务断裂）。
 *
 * 测试 hook：单测 / e2e 通过 ``setMarkCredentialUsedFn`` 注入断言函数验证：
 *   - 成功路径必调；
 *   - 失败路径（reveal null / fill 失败 / submit 失败 / verify 失败）必不调。
 */
let markCredentialUsedFn:
  | ((credentialId: string) => Promise<boolean>)
  | null = null

export function setMarkCredentialUsedFn(
  fn: ((credentialId: string) => Promise<boolean>) | null,
): void {
  markCredentialUsedFn = fn
}

/**
 * 通知 renderer "Agent 自动 autofill 失败"。
 *
 * Wave 4 三视角 Review 视角 1+2 P0 自修：
 *   - 视角 2#1：preload 层增加 ``onAgentAutofillFailed`` expose，renderer 端
 *     ``ContentArea`` 起 Toast 订阅，文案按 PRD Story 5 写"自动登录 {domain}
 *     失败，密码可能已过期，请到「设置 → 登录与密钥」更新"——这条 self-fix
 *     在 ``apps/tabtin-electron/src/preload/index.ts`` + ``ContentArea.tsx``
 *     接线（renderer 端不属于本文件范围）。
 *   - 视角 1#3 / 视角 2#5：Agent runtime 也要拿到失败信号，通过 RunSessionManager
 *     addObservation 注入对话流，让 Agent 在 ReAct loop 里能区分"凭据过期 vs
 *     2FA vs 网络故障"——见 ``recordAgentAutofillObservation`` 函数。
 */
/**
 * Wave 4 三视角 Review 视角 2 P2 发现 4 自修：测试 hook。
 *
 * 默认走 ``getMainWindow().webContents.send``——但 e2e 环境里 main window
 * 不存在，IPC 静默丢弃，原本测试断言"成功/失败 IPC 是否真的发出"完全不可
 * 见。注入 emitter 让 e2e 能断言 IPC payload。
 *
 * 安全：emitter 收到的 reason / payload 都不含明文密码（见
 * ``notifyRendererAgentAutofillFailed`` / ``notifyRendererAgentAutofillSucceeded``
 * 实现）；本 hook 不影响 Wave 4 安全不变量。
 */
type AgentAutofillFailedEmitter = (payload: {
  tabId: string
  code: string
  credentialId?: string
  domain?: string
  detail?: string
  spaceId?: string
}) => void
let agentAutofillFailedEmitter: AgentAutofillFailedEmitter | null = null
export function setAgentAutofillFailedEmitter(fn: AgentAutofillFailedEmitter | null): void {
  agentAutofillFailedEmitter = fn
}

type AgentAutofillSucceededEmitter = (payload: {
  tabId: string
  domain: string
  maskedUsername: string
  credentialId: string
  spaceId?: string
}) => void
let agentAutofillSucceededEmitter: AgentAutofillSucceededEmitter | null = null
export function setAgentAutofillSucceededEmitter(fn: AgentAutofillSucceededEmitter | null): void {
  agentAutofillSucceededEmitter = fn
}

function notifyRendererAgentAutofillFailed(
  tabId: string,
  reason: {
    code: string
    credentialId?: string
    domain?: string
    detail?: string
    /**
     * Wave 4 三视角 Review 视角 2 P1 发现 3 自修：透传 spaceId 让 renderer
     * 反查 Agent 名字。多 Agent 协作场景下用户必须能区分"是哪个 Agent 在动"——
     * "研究助手 自动登录 X 失败" vs "Agent 自动登录 X 失败"，前者用户能直接
     * 定位事件源。spaceId 不是敏感数据，零安全风险。
     */
    spaceId?: string
  },
): void {
  if (agentAutofillFailedEmitter) {
    agentAutofillFailedEmitter({ tabId, ...reason })
    return
  }
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    log.warn('no main window for agent-autofill-failed notification', { tabId, reason })
    return
  }
  mainWindow.webContents.send('credential-vault:agent-autofill-failed', { tabId, ...reason })
}

/**
 * Wave 4 三视角 Review 视角 2 P1 发现 2 自修：成功路径也要 toast。
 *
 * **背景**：PD-9（不做敏感网站名单 + 自动允许）+ PD-10（多匹配自动取
 * last_used_at 第一条）叠加，Wave 4 上线后 Agent 在不可见的后台 view 上自动用
 * 用户保存的密码登录任何网站——包括银行 / 支付 / 邮箱。本期不做敏感网站
 * 守门是产品决策，但**用户必须**至少**事后**能看到"Agent 刚刚用了某账号
 * 自动登录某站"。否则用户体感是"TabTin 擅自动我账户"——信任崩盘。
 *
 * 这条 toast 是 PD-9 的"产品诚实度"兜底：不挡 Agent 行动，但不让动作隐形。
 *
 * 数据约束：
 *   - **不传明文密码** —— 只发 (tabId, domain, maskedUsername, credentialId)；
 *   - **maskedUsername** 主进程层做：`alice@example.com → al***@example.com`
 *     避免完整邮箱进 IPC payload（Wave 5 的 PII 治理预热）。
 */
function notifyRendererAgentAutofillSucceeded(
  tabId: string,
  payload: { domain: string; username: string; credentialId: string; spaceId?: string },
): void {
  const out = {
    tabId,
    domain: payload.domain,
    maskedUsername: maskUsername(payload.username),
    credentialId: payload.credentialId,
    // Wave 4 三视角 Review 视角 2 P1 发现 3 自修：spaceId 透传到 renderer 用于反查 Agent
    ...(payload.spaceId ? { spaceId: payload.spaceId } : {}),
  }
  if (agentAutofillSucceededEmitter) {
    agentAutofillSucceededEmitter(out)
    return
  }
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) {
    // 不打 warn——success 路径用户视角是"成功了"，主窗口暂时不可用是可接受降级
    return
  }
  mainWindow.webContents.send('credential-vault:agent-autofill-succeeded', out)
}

/**
 * 用户名脱敏（保护邮箱 / 手机号 PII）。
 *
 * 规则（与 ``schemas.py::mask_value`` 风格一致）：
 *   - 邮箱 a@b → `a***@b`（保 1 位前缀 + 域名）
 *   - 长度 ≤ 4 → 全 *
 *   - 其余 → 前 2 + *** + 后 1
 */
function maskUsername(username: string): string {
  if (!username) return ''
  const at = username.indexOf('@')
  if (at > 0) {
    const local = username.slice(0, at)
    const domain = username.slice(at)
    if (local.length <= 1) return local + '***' + domain
    return local.slice(0, 1) + '***' + domain
  }
  if (username.length <= 4) return '****'
  return username.slice(0, 2) + '***' + username.slice(-1)
}

/**
 * Wave 4 三视角 Review 视角 1#3 + 视角 2#5 自修：把 Agent autofill 的关键事件
 * 注入对应 run 的 observation 流。
 *
 * **当前接线状态（Wave 4 真·Review 视角 2 P1 发现 3 自修，2026-04-26）**：
 *
 *   - 这些 observation **写到 RunSession.observations 数组 + EventPersistence
 *     落盘**（``RunSessionManager.addObservation``）；
 *   - **但 Wave 4 没有把 observation 喂回 LLM 上下文的接线**——LLM 上下文
 *     拼接发生在 ``packages/agent-runtime`` 调用前，而那里目前只读 user
 *     messages + tool results，**不读 RunSession observation**；
 *   - 因此 Agent 实际上**看不到** AGENT_AUTOFILL_FAILED，无法据此区分"凭据
 *     过期 vs 2FA vs 网络故障"。这条**改成 Wave 5 范围**接线（三视角 Review
 *     视角 2 P1 发现 3 标记为伪承诺）。
 *
 * **当前真实价值**（不是空头支票）：
 *   1. **持久化排查证据**：用户报"Agent 自动登录某站失败但不知为什么"，运维
 *      可以从 `~/.tabtin/run-events/*.jsonl` 里捞 AGENT_AUTOFILL_FAILED
 *      事件 + code 字段诊断；
 *   2. **renderer 端 IPC 通知 + toast** 已经接通（``notifyRendererAgentAutofill*``
 *      + ``AgentAutofillFailedToast.tsx``），用户在前台 view 上能看到失败 toast；
 *   3. **Wave 5 LLM 上下文消费链路落地后**，本次写入的 observation 立即
 *      可用——本期写入是为 Wave 5 提前埋点。
 *
 * 注入语义：
 *   - **AGENT_AUTOFILL_TRIGGERED**：开始 fill 前注入；
 *   - **AGENT_AUTOFILL_FAILED**：reveal 失败 / fill 失败注入，data 含 code；
 *   - **AGENT_AUTOFILL_SUCCESS**：fill 完成 + submit 触发后注入。
 *
 * **不**记录 username / password 字段——只记 credentialId 让排查在凭据库
 * 范围内自描述，避免任何 PII 进 observation。
 *
 * 用 Lazy require 避开循环依赖（与 viewClassificationFn 模式一致）。
 */
function recordAgentAutofillObservation(
  runId: string | undefined,
  tabId: string,
  type: 'AGENT_AUTOFILL_TRIGGERED' | 'AGENT_AUTOFILL_FAILED' | 'AGENT_AUTOFILL_SUCCESS',
  data: {
    credentialId?: string
    domain?: string
    matchCount?: number
    code?: string
    detail?: string
    submitVia?: string
  },
): void {
  if (!runId) return
  try {
    getRunSessionManager().addObservation({
      runId,
      viewId: tabId,
      type,
      data,
    })
  } catch (err) {
    // RunSessionManager 未初始化或导入失败 → 静默。Wave 4 默认 e2e
    // 不调用此路径（无 RunSession 上下文）；生产路径才接通。
    log.warn(
      'recordAgentAutofillObservation failed:',
      err instanceof Error ? err.message : String(err),
    )
  }
}

/**
 * Agent 后台 view 自动填充并提交。
 *
 * 不变量（极其关键）：
 *   1. **plaintext.password 绝对不进入任何持久化路径** —— 不写日志、不发 IPC、
 *      不返回到调用栈外层；只在本函数局部变量中存活直到 fillLoginForm 调用结束；
 *   2. **recordRecentSubmit 在 fill 之前调用**（Wave 4 真·真 Review 视角 1 P1 发
 *      现 2 自修）—— 旧顺序是 fill → record → submit，但激进登录页（React
 *      onChange 自动校验+提交、原生 input change handler 主动调 form.submit()）
 *      会让页面在 FILL_FORM_SCRIPT 执行期间就触发 submit → PASSWORD_CAPTURE
 *      script 同步 fire → postMessage 入队 → preload `ipcRenderer.invoke
 *      ('credential-vault:password-captured', ...)` 在 main 进程 record 之前抵达
 *      → onPasswordSubmitted 走 update 路径误改 last_used / 触发 capture 路径副
 *      作用。**先 record 后 fill**：record 成本是 32 字节 hash + Date.now()，
 *      fill 失败时多留 30s 死记录的副作用极小（recentSubmits 只看 hash 不看
 *      tab/domain），换来 race-free 闭环。
 *   3. **submit 失败 → 通知 renderer "fill ok 但 submit 失败"**（Wave 4 真·真
 *      Review 视角 3 P1 发现 1 自修）—— 旧实现 fill 成了就 emit succeeded toast，
 *      submit 失败也算"已自动登录"——反 PD-9 产品诚实度。修复：把 submit 结
 *      果纳入决策，submit 失败走 ``code='submit-failed'`` 失败 toast +
 *      observation。
 */
async function runAgentAutofill(
  tabId: string,
  webContents: WebContents,
  matches: CredentialMatch[],
  domain: string,
  classification: ViewClassification | null,
): Promise<void> {
  if (matches.length === 0) return

  // PD-10：matches 已经在后端按 last_used_at DESC NULLS LAST, created_at DESC
  // 排序好了；这里直接取第一条。
  const target = matches[0]
  const runId = classification?.runId
  // Wave 4 三视角 Review 视角 2 P1 发现 3 自修：spaceId 透传到 emitter / observation 让
  // renderer 反查 Agent 名字，多 Agent 协作场景下用户能区分"是哪个 Agent 在动"。
  const spaceId = classification?.spaceId
  log.info(
    'agent autofill triggered',
    {
      tabId,
      domain,
      credentialId: target.id,
      matchCount: matches.length,
      // 不打 username 全文——避免日志里泄漏邮箱等 PII
      hasMultipleMatches: matches.length > 1,
    },
  )
  // Wave 4 视角 1#3 + 视角 2#5：Agent 能感知到"我即将自动登录"
  recordAgentAutofillObservation(runId, tabId, 'AGENT_AUTOFILL_TRIGGERED', {
    credentialId: target.id,
    domain,
    matchCount: matches.length,
  })

  if (!revealForAutofillWithoutDialogFn) {
    log.warn('revealForAutofillWithoutDialogFn not configured')
    notifyRendererAgentAutofillFailed(tabId, {
      code: 'reveal-fn-not-configured',
      credentialId: target.id,
      domain,
      ...(spaceId ? { spaceId } : {}),
    })
    recordAgentAutofillObservation(runId, tabId, 'AGENT_AUTOFILL_FAILED', {
      code: 'reveal-fn-not-configured',
      credentialId: target.id,
      domain,
    })
    return
  }

  let plaintext: { url: string; username: string; password: string } | null = null
  try {
    plaintext = await revealForAutofillWithoutDialogFn(target.id)
  } catch (err: any) {
    log.warn(
      'agent autofill: reveal threw',
      { tabId, credentialId: target.id, error: err?.message || String(err) },
    )
  }

  if (!plaintext) {
    // 410 expired/inactive / 401 / 网络失败 都走这条 — 凭据不可用
    notifyRendererAgentAutofillFailed(tabId, {
      code: 'credential-unavailable',
      credentialId: target.id,
      domain,
      detail: 'Reveal returned null — credential may be expired/inactive or network failed',
      ...(spaceId ? { spaceId } : {}),
    })
    recordAgentAutofillObservation(runId, tabId, 'AGENT_AUTOFILL_FAILED', {
      code: 'credential-unavailable',
      credentialId: target.id,
      domain,
      detail: 'Credential reveal returned null — may be expired/inactive',
    })
    return
  }

  if (webContents.isDestroyed()) {
    return
  }

  // ── 真·真 Review 视角 1 P1 发现 2 自修（V1#2 race 防御）──
  //
  // 先 record 后 fill：page 端激进 onChange / change handler 在 FILL_FORM_SCRIPT
  // 执行期间触发 submit + capture → IPC 抢先到达 main → onPasswordSubmitted
  // 在 record 之前看到该密码 → 走 update 路径误改 last_used。
  //
  // record 的成本是 32 字节 hash + Date.now()——fill 失败时只是 30s 内多留一条
  // 死记录，副作用极小（recentSubmits 只看 hash 不看 tab/domain，正常用户在 30s
  // 内手动输不同密码登录另一站不命中）。换来"无论 fill 时序如何 race，capture
  // 信号都会被 dedup"的硬保证。
  try {
    const currentDomain =
      resolveDedupDomain(webContents, { hintDomain: domain, credentialUrl: plaintext.url }) || domain
    recordRecentSubmit(hashPasswordShort(plaintext.password), currentDomain)
  } catch (err) {
    log.warn('agent autofill: recordRecentSubmit failed:', err)
  }

  let filled = false
  try {
    filled = await fillLoginForm(webContents, plaintext.username, plaintext.password, plaintext.url)
  } catch (err: any) {
    log.warn(
      'agent autofill: fillLoginForm threw',
      { tabId, error: err?.message || String(err) },
    )
  }

  if (!filled) {
    notifyRendererAgentAutofillFailed(tabId, {
      code: 'fill-failed',
      credentialId: target.id,
      domain,
      detail: 'fillLoginForm returned false — domain mismatch or DOM unavailable',
      ...(spaceId ? { spaceId } : {}),
    })
    recordAgentAutofillObservation(runId, tabId, 'AGENT_AUTOFILL_FAILED', {
      code: 'fill-failed',
      credentialId: target.id,
      domain,
      detail: 'fillLoginForm returned false — domain mismatch or DOM unavailable',
    })
    return
  }

  // ── T2：自动 submit ──
  //
  // 真·真 Review 视角 3 P1 发现 1 自修：把 submit 结果纳入决策。
  let submitResult: { submitted: boolean; via?: string; reason?: string }
  try {
    submitResult = await submitLoginForm(webContents)
  } catch (err: any) {
    submitResult = { submitted: false, reason: 'execute-failed: ' + (err?.message || String(err)) }
  }

  log.info(
    'agent autofill: fill+submit done',
    {
      tabId,
      domain,
      credentialId: target.id,
      filled: true,
      submitted: submitResult.submitted,
      submitVia: submitResult.via,
      submitReason: submitResult.reason,
    },
  )

  if (!submitResult.submitted) {
    // 真·真 Review 视角 3 P1 发现 1 自修：fill 成了但 submit 没成功，**不能**
    // emit succeeded toast——反 PD-9 诚实度（用户看到"已自动登录" 但实际密
    // 码只塞进了 DOM 没真提交）。改为 ``code='submit-failed'`` 失败路径，文
    // 案提示用户"密码已填入登录表单但未自动提交，请手动点击登录"。
    notifyRendererAgentAutofillFailed(tabId, {
      code: 'submit-failed',
      credentialId: target.id,
      domain,
      detail:
        'fillLoginForm 成功但 submitLoginForm 未触发提交：' +
        (submitResult.reason || 'unknown'),
      ...(spaceId ? { spaceId } : {}),
    })
    recordAgentAutofillObservation(runId, tabId, 'AGENT_AUTOFILL_FAILED', {
      code: 'submit-failed',
      credentialId: target.id,
      domain,
      detail: submitResult.reason,
      submitVia: submitResult.via,
    })
    return
  }

  // Wave 4 三视角 Review 视角 2 P1 发现 2 自修：成功路径用户必须可见。
  // PD-9 不挡 Agent 自动登录任何网站（包括银行 / 支付）；这条 toast 是
  // 产品诚实度兜底——用户事后能看到"Agent 用了哪个账号登了哪个站"。
  // payload 不带密码，username 已脱敏。
  notifyRendererAgentAutofillSucceeded(tabId, {
    domain,
    username: plaintext.username,
    credentialId: target.id,
    ...(spaceId ? { spaceId } : {}),
  })
  recordAgentAutofillObservation(runId, tabId, 'AGENT_AUTOFILL_SUCCESS', {
    credentialId: target.id,
    domain,
    submitVia: submitResult.via,
  })

  // ── Wave 5a (L-W4-4)：verifyLoginSuccess + mark-used ──
  //
  // 设计选择（Wave 5a 决策）：**verify 不挡 succeeded toast**。
  //
  // 旧 Wave 4 行为：fill ok + submit ok → succeeded toast + 后端 reveal 自
  // 动写 last_used_at（污染源）。
  //
  // 新 Wave 5a 行为：
  //   - succeeded toast 仍按 fill+submit ok 即发（保持 Wave 4 用户感知不破坏）；
  //   - reveal 不再自动写 last_used_at（后端 ``_issue_autofill_credential`` 已删）；
  //   - **mark-used 单独由 verifyLoginSuccess 守门**：只有 verify 真正确认
  //     登录成功（URL 变化 + 无密码框 / SPA pushState / title 变化）才调
  //     mark-used 写 last_used_at。
  //
  // 这样做的取舍：
  //   - **优点**：单元测试 / e2e 不需要 mock verifyLoginSuccess（Wave 4 测试桩
  //     全部直接复用）；用户感知零变化；last_used_at 污染问题被 verify 守门
  //     堵死；
  //   - **代价**：极端 case 下用户看到"已自动登录" toast 但 last_used_at 没
  //     被写——但 last_used_at 是 Wave 5 设置页"最近使用"列的次要信号，
  //     不写最多让该凭据下次 match 排在更后（保守、不污染），用户感知差异
  //     极小。
  //
  // 失败 / mark-used 异常静默 —— 仅是排序展示瑕疵，业务路径未断。
  let verified = false
  try {
    verified = await verifyLoginSuccess(tabId, plaintext.url || webContents.getURL(), 1500)
  } catch (err: any) {
    log.warn('agent autofill: verifyLoginSuccess threw', {
      tabId, error: err?.message || String(err),
    })
  }

  if (verified && markCredentialUsedFn) {
    try {
      const ok = await markCredentialUsedFn(target.id)
      if (!ok) {
        log.warn('agent autofill: mark-used returned false', {
          tabId, credentialId: target.id,
        })
      }
    } catch (err: any) {
      log.warn('agent autofill: mark-used threw', {
        tabId, error: err?.message || String(err),
      })
    }
  } else if (!verified) {
    log.info('agent autofill: verifyLoginSuccess returned false → skipping mark-used', {
      tabId, credentialId: target.id,
    })
  }
}

/**
 * Wave 3 三视角 Review 视角 3 P1 发现 1：autofill suggestion 去重 key 计算。
 *
 * 取 `origin + pathname`：
 *   - 同站同路径，query/hash 不同 → 同 key（不重复弹）
 *   - 不同 path（/login vs /signin）→ 不同 key（重新尝试 suggest）
 *   - 不同 origin → 不同 key
 *
 * URL 解析失败时退化为完整 url 字符串作 key（保持原有行为，不会更糟）。
 */
function computeSuggestKey(url: string): string {
  try {
    const u = new URL(url)
    return u.origin + u.pathname
  } catch {
    return url
  }
}

// ════════════════════════════════════════════════════════════════════
// Wave 3 G2：密码提交后的保存决策
// ════════════════════════════════════════════════════════════════════

/**
 * 登录验证轮询参数（供 onPasswordSubmitted 生产路径使用）。
 *
 * - 首次等待 1.5s（保持 Wave 3 行为，让登录请求往返 + 跳转完成）；
 * - 之后每 1.5s 轮询一次，最长 12s——覆盖"点登录 → 过滑块/图形验证码 →
 *   才真正跳转成功"的延迟场景（京东等站点登录常弹滑块，用户滑完才登录成功，
 *   固定 1.5s 窗口会在滑块完成前就判失败 → 抓到密码也不弹保存条）。
 *
 * 做成模块级可覆盖变量：单测通过 `__setLoginVerifyTimingForTest` 调成 0，
 * 避免真的等待/轮询导致超时；Agent 后台路径直接传 number（只等一次不轮询）。
 */
const LOGIN_VERIFY_DEFAULT_TIMING = {
  waitMs: 1_500,
  maxWaitMs: 12_000,
  pollIntervalMs: 1_500,
}
let loginVerifyTiming = { ...LOGIN_VERIFY_DEFAULT_TIMING }

export function __setLoginVerifyTimingForTest(
  t: Partial<typeof LOGIN_VERIFY_DEFAULT_TIMING> | null,
): void {
  loginVerifyTiming = t ? { ...loginVerifyTiming, ...t } : { ...LOGIN_VERIFY_DEFAULT_TIMING }
}

/**
 * 读取指定 URL 在该 webContents 会话下的 cookie 名集合（快照）。
 *
 * 用于 verifyLoginSuccess 的"会话 Cookie 新增"信号：submit 时刻快照一次，
 * 验证时再快照对比，出现新 cookie 名 = 登录成功的本质证据（服务端下发会话）。
 *
 * 降级：wc 无 `session`（单测 mock）/ cookies API 不可用 / 读取抛异常 → 返回
 * 空集合，cookie 信号自动不参与判定（回退到 URL/title/in-page-nav 信号）。
 */
async function snapshotCookieNames(wc: WebContents | null, url: string): Promise<Set<string>> {
  const names = new Set<string>()
  if (!wc || wc.isDestroyed() || !url) return names
  try {
    const session = (wc as unknown as { session?: Electron.Session }).session
    if (!session?.cookies?.get) return names
    const cookies = await session.cookies.get({ url })
    if (Array.isArray(cookies)) {
      for (const c of cookies) {
        if (c && typeof c.name === 'string') names.add(c.name)
      }
    }
  } catch {
    // cookie 读取失败 → 空快照 → cookie 信号不参与（保守降级）
  }
  return names
}

/**
 * 单次登录成功判定（多信号融合）。
 *
 * 返回：
 *   - 'success'：命中成功信号（下述任一 + 无密码框）；
 *   - 'fail'：硬失败（tab 关闭 / wc 销毁），应立即终止轮询，保守不弹；
 *   - 'pending'：本次未命中成功信号，但也未硬失败——可继续轮询等待。
 *
 * 成功信号（任一 + 无密码框）：
 *   - **强信号**：URL 变化（传统跳转 / SPA pushState 改了 main-frame URL）；
 *   - **中信号**：提交后发生过 in-page navigation（pushState/hash）；
 *   - **中信号**：title 变化（连 history 都不动的极简 SPA）；
 *   - **中信号**：会话 Cookie 新增（服务端下发登录态；baseline 非空才启用）。
 *
 * 为什么"无密码框"是所有成功路径的必要条件：登录失败页通常保留密码框（即使
 * 显示错误），保守不弹比误弹好（误弹会把错误密码存进去，危害更大）。
 */
async function checkLoginSuccessOnce(
  tabId: string,
  originalUrl: string,
  originalTitle: string | undefined,
  submitTimestamp: number,
  cookieBaseline: Set<string> | undefined,
): Promise<'success' | 'fail' | 'pending'> {
  const wc = webContentsMap.get(tabId)
  if (!wc || wc.isDestroyed()) {
    // tab 关了 = 可能跳到外部应用 / 用户关闭窗口；保守终止
    return 'fail'
  }

  const currentUrl = wc.getURL()
  const urlChanged = currentUrl !== originalUrl

  let currentTitle = ''
  try {
    currentTitle = wc.getTitle?.() ?? ''
  } catch {
    // 极少数 webContents 可能不支持 getTitle，无所谓
  }
  const titleChanged = Boolean(
    originalTitle && currentTitle && originalTitle !== currentTitle,
  )

  // in-page navigation 信号：必须发生在 submit 之后，否则是登录前的页面跳转
  const navRec = inPageNavMap.get(tabId)
  const inPageNavAfterSubmit = Boolean(
    navRec && navRec.lastInPageNavAt > submitTimestamp,
  )

  // 无密码框信号——登录失败页面通常会保留密码框（让用户重新输）
  let stillHasPwdForm = false
  try {
    stillHasPwdForm = Boolean(await wc.executeJavaScript(
      `document.querySelectorAll('input[type="password"]').length > 0`,
      true,
    ))
  } catch {
    // executeJavaScript 异常（页面跳转中、context destroyed）→ 当作"已离开登录页"
    stillHasPwdForm = false
  }

  // 会话 Cookie 新增信号（baseline 非空才启用——空 baseline 可能是读取失败或
  // 全新会话，无法可靠判断"新增"，此时降级不参与，避免把埋点 cookie 误判成功）
  let cookieAdded = false
  if (cookieBaseline && cookieBaseline.size > 0) {
    const now = await snapshotCookieNames(wc, currentUrl)
    for (const name of now) {
      if (!cookieBaseline.has(name)) {
        cookieAdded = true
        break
      }
    }
  }

  // ── 决策（严格保守：所有"成功"路径都要求 !stillHasPwdForm）──
  if (!stillHasPwdForm && (urlChanged || inPageNavAfterSubmit || titleChanged || cookieAdded)) {
    return 'success'
  }
  // 未命中成功信号但也没硬失败 → 交给轮询继续等（滑块/验证码延迟）
  return 'pending'
}

/**
 * 验证登录是否成功（多信号融合 + 轮询）。
 *
 * 流程：首次等待 `waitMs`，之后每 `pollIntervalMs` 轮询一次直到 `maxWaitMs`
 * 上限。任一次命中成功信号立即返回 true；硬失败（wc 销毁）立即返回 false；
 * 超时仍未命中 → false。
 *
 * 向后兼容：第三参数传 number 时 `maxWaitMs` 默认等于 `waitMs`（即只检查一次、
 * 不轮询），与 Wave 3 单测 / Agent 后台路径行为完全一致。
 *
 * **不发 GET 重新请求页面**——只看当前 webContents 状态，验证快、不破坏页面。
 *
 * @param tabId 用 tabId 反查 webContents（webContents 引用本身可能销毁）
 * @param originalUrl form submit 时的 URL
 * @param waitMsOrOptions number（首次等待，兼容旧签名）或 options：
 *   - waitMs：首次等待，默认 1500
 *   - originalTitle：submit 时 page title（SPA title 变化检测）
 *   - submitTimestamp：submit 时间戳（区分提交前后的 in-page nav）
 *   - maxWaitMs：轮询总上限，默认等于 waitMs（不轮询）
 *   - pollIntervalMs：轮询间隔，默认 1500
 *   - cookieBaseline：submit 时刻的 cookie 名快照（启用 Cookie 新增信号）
 */
export async function verifyLoginSuccess(
  tabId: string,
  originalUrl: string,
  waitMsOrOptions: number | {
    waitMs?: number
    originalTitle?: string
    submitTimestamp?: number
    maxWaitMs?: number
    pollIntervalMs?: number
    cookieBaseline?: Set<string>
  } = 1500,
): Promise<boolean> {
  // 兼容旧签名：第三参数可以是 number（waitMs）或 options 对象
  const opts = typeof waitMsOrOptions === 'number'
    ? { waitMs: waitMsOrOptions }
    : waitMsOrOptions
  const waitMs = opts.waitMs ?? 1500
  const originalTitle = opts.originalTitle
  const submitTimestamp = opts.submitTimestamp ?? (Date.now() - waitMs)
  // 轮询总上限默认等于首次等待（即不轮询，兼容旧调用与单测）
  const maxWaitMs = Math.max(opts.maxWaitMs ?? waitMs, waitMs)
  const pollIntervalMs = Math.max(opts.pollIntervalMs ?? 1500, 1)
  const cookieBaseline = opts.cookieBaseline

  // 首次等待（让登录请求往返 + 跳转完成）
  await new Promise((resolve) => setTimeout(resolve, waitMs))
  let elapsed = waitMs

  for (;;) {
    const result = await checkLoginSuccessOnce(
      tabId,
      originalUrl,
      originalTitle,
      submitTimestamp,
      cookieBaseline,
    )
    if (result !== 'pending') return result === 'success'
    if (elapsed >= maxWaitMs) return false
    const nextWait = Math.min(pollIntervalMs, maxWaitMs - elapsed)
    if (nextWait <= 0) return false
    await new Promise((resolve) => setTimeout(resolve, nextWait))
    elapsed += nextWait
  }
}

/**
 * 域名黑名单缓存：5min TTL（防止脚本化提交时反复打后端）。
 *
 * Wave 3 PD-8：黑名单存后端（跨设备保留）。本地缓存只是性能优化，
 * 用户在设置页移除黑名单 → 后端立即生效，本地缓存最长 5min 漂移；
 * 下一次密码提交时如果误命中，用户能从 SavePasswordBar 看到，可手动 dismiss。
 */
const blacklistCache = new Map<string, { blacklisted: boolean; cachedAt: number }>()
const BLACKLIST_CACHE_TTL_MS = 5 * 60 * 1000

let blacklistCheckFn: ((domain: string) => Promise<boolean>) | null = null

export function setBlacklistCheckFn(fn: (domain: string) => Promise<boolean>): void {
  blacklistCheckFn = fn
}

export function __clearBlacklistCacheForTest(): void {
  blacklistCache.clear()
}

export async function checkDomainBlacklist(domain: string): Promise<boolean> {
  const now = Date.now()
  const entry = blacklistCache.get(domain)
  if (entry && now - entry.cachedAt < BLACKLIST_CACHE_TTL_MS) {
    return entry.blacklisted
  }
  if (!blacklistCheckFn) return false
  try {
    const blacklisted = await blacklistCheckFn(domain)
    blacklistCache.set(domain, { blacklisted, cachedAt: now })
    return blacklisted
  } catch (err) {
    log.warn('blacklist check failed, treating as not blacklisted:', err)
    return false
  }
}

/**
 * 接收 preload 转发的密码捕获事件 → 决策是否弹保存条。
 *
 * 决策树：
 *   1. 黑名单命中 → 直接 return（不弹）
 *   2. verifyLoginSuccess 失败 → return（输错 / 2FA / 仍在登录页）
 *   3. 凭据库匹配：
 *      - 同 (域名, username, password)：完全一致 → 静默跳过
 *      - 同 (域名, username) 但密码变了 → mode='update'
 *      - 同域名不同 username → mode='new-account'
 *      - 全新 → mode='save'
 *   4. emit `credential-vault:save-prompt` 给 renderer
 *
 * 不变量：
 *   - 函数永不抛异常——任何失败都 return 让流程静默结束。
 *   - **payload.url 在生产链路里由主进程从 sender.getURL() 注入**（见
 *     password-captured handler），单测/E2E 直接调本函数时也必须传入与
 *     wc.getURL() 一致的 url，否则被 domain 一致性兜底拒绝。
 *
 * Wave 3 P0 修复（视角 1 #2 投毒）：
 *   - 入口加 domain 一致性兜底：payload.url 的 domain 必须与 wc.getURL() 的
 *     domain 在 doDomainsMatch 意义下一致，否则视为 page 自报 url 投毒拒绝
 *     （preload 已经不传 url 了，这里是双保险）。
 */
export async function onPasswordSubmitted(
  tabId: string,
  payload: { url: string; username: string; password: string },
): Promise<void> {
  const { url, username, password } = payload
  if (!password) return

  const domain = extractDomain(url)
  if (!domain) return

  // ── domain 一致性兜底（Wave 3 P0 视角 1#2）──
  // payload.url 来自 page main world / 测试调用，主进程必须用 wc.getURL()
  // 兜底，确保 payload.url 没被恶意伪造。
  //
  // Wave 3 修正版 真问题 2：同时抓 submit 时刻的 title 和时间戳，喂给
  // verifyLoginSuccess 做 SPA 多信号判定。
  const wc = webContentsMap.get(tabId)
  let submitTitle: string | undefined
  let cookieBaseline: Set<string> | undefined
  if (wc && !wc.isDestroyed()) {
    const realUrl = wc.getURL()
    const realDomain = extractDomain(realUrl)
    if (realDomain && !domainsCompatible(domain, realDomain)) {
      log.warn(
        'payload.url domain 与 webContents URL 不一致，拒绝（可能是页面投毒）:',
        { payloadDomain: domain, realDomain, tabId },
      )
      return
    }
    try {
      submitTitle = wc.getTitle?.()
    } catch {
      // 老版本 Electron / WebContents getTitle 不存在：无所谓，verify 时
      // titleChanged 信号会被 originalTitle 缺席的判空 short-circuit 掉
    }
    // 快照 submit 时刻的 cookie 名，喂给 verifyLoginSuccess 的"会话 Cookie
    // 新增"信号——覆盖京东这类"点登录 → 滑块 → 才下发登录态 cookie"的场景。
    cookieBaseline = await snapshotCookieNames(wc, realUrl)
  }
  const submitTimestamp = Date.now()

  // ── 黑名单守门 ──
  if (await checkDomainBlacklist(domain)) {
    log.info('domain blacklisted, skipping save prompt:', domain)
    return
  }

  // ── Wave 3 修正版 Review 视角 1+2 P0 自修：30s 内同密码去重 ──
  // 覆盖：
  //   1. OAuth 多跳（accounts.google.com → 第三方 callback 也 capture 同密码）
  //   2. Agent autofill 后 click 登录按钮触发的二次 capture（autofill 回声）
  // 详见 recentSubmits docstring。
  //
  // Wave 3 三视角 Review 视角 1 P1 发现 3 自修（telemetry）：
  //   recentSubmits 是 module-level singleton，**不区分 tabId**——Wave 4 上线
  //   "Agent 自动 fill+click"后，Agent 在 background tab fill 一次同密码，
  //   用户在前台 tab 同密码登录另一个网站会被静默吞掉。当前不改全局 state
  //   语义（避免 Wave 5 reflection 5 教训"仓促改全局状态比留 bug 更危险"），
  //   但加 telemetry 让"跨 tab dedup 命中"在日志里可见，方便排查。
  const passwordHashShort = hashPasswordShort(password)
  if (isRecentlySubmittedDuplicate(passwordHashShort)) {
    // 找原 record 看 domain 是否同
    const matchingRecord = recentSubmits.find((r) => r.passwordHashShort === passwordHashShort)
    const isCrossDomain = matchingRecord && matchingRecord.domain !== domain
    const isCrossTab = false // recentSubmits 现在不存 tabId；future Wave 4 起改造
    log.info(
      'same password recently submitted, skipping save prompt:',
      {
        domain,
        tabId,
        prevDomain: matchingRecord?.domain,
        crossDomain: isCrossDomain,
        crossTab: isCrossTab,
        likelyReason: isCrossDomain ? 'OAuth relay' : 'autofill replay or duplicate submit',
      },
    )
    return
  }

  // ── 验证登录成功（多信号融合 + 轮询，覆盖滑块/验证码延迟）──
  const success = await verifyLoginSuccess(tabId, url, {
    waitMs: loginVerifyTiming.waitMs,
    originalTitle: submitTitle,
    submitTimestamp,
    maxWaitMs: loginVerifyTiming.maxWaitMs,
    pollIntervalMs: loginVerifyTiming.pollIntervalMs,
    cookieBaseline,
  })
  if (!success) {
    log.info('login verification failed, skipping save prompt:', { domain, tabId })
    return
  }

  // ── 凭据库匹配 ──
  if (!credentialMatchFn) {
    log.warn('credentialMatchFn not configured, cannot decide save mode')
    return
  }

  let matches: CredentialMatch[] = []
  try {
    matches = await credentialMatchFn(domain)
  } catch (err) {
    log.warn('credential match failed during save decision:', err)
    // 匹配失败 → 当作无匹配（mode='save'），让用户决定
  }

  // 同 username 已存在 → 比对密码决定 update / skip
  const sameUser = matches.find((m) => m.username === username)
  if (sameUser) {
    let existing: { url: string; username: string; password: string } | null = null
    if (credentialFetchPlaintextFn) {
      try {
        existing = await credentialFetchPlaintextFn(sameUser.id)
      } catch (err) {
        log.warn('fetch plaintext for compare failed:', err)
      }
    }
    if (existing && existing.password === password) {
      // 完全一致 → 静默
      log.info('credential matches existing, skipping save prompt:', { domain, username })
      return
    }
    // 同账号密码变了 → 提示更新
    stashPendingAndEmit(tabId, {
      mode: 'update',
      domain,
      url,
      username,
      password,
      credentialId: sameUser.id,
    })
    return
  }

  // 同域名不同 username → 提示保存为新账号
  if (matches.length > 0) {
    stashPendingAndEmit(tabId, {
      mode: 'new-account',
      domain,
      url,
      username,
      password,
      existingUsernames: matches.map((m) => m.username),
    })
    return
  }

  // 全新 → 提示保存
  stashPendingAndEmit(tabId, {
    mode: 'save',
    domain,
    url,
    username,
    password,
  })
}

/**
 * 把密码暂存到主进程 pending map，emit 给 renderer 的 payload **不含** password。
 *
 * 为什么不直接传密码：见 `pendingSavePasswords` docstring —— 密码全程留在
 * 主进程内存，renderer 只拿足够展示 UI 的字段。
 */
function stashPendingAndEmit(
  tabId: string,
  args: {
    mode: SavePromptMode
    domain: string
    url: string
    username: string
    password: string
    credentialId?: string
    existingUsernames?: string[]
  },
): void {
  const expiresAt = Date.now() + PENDING_SAVE_TTL_MS
  pendingSavePasswords.set(tabId, {
    password: args.password,
    url: args.url,
    username: args.username,
    domain: args.domain,
    mode: args.mode,
    ...(args.credentialId ? { credentialId: args.credentialId } : {}),
    expiresAt,
  })
  scheduleClearPending(tabId)

  // 记 recent submit 用于跨 domain 去重（Wave 3 视角 1+2 P0 自修）
  // Wave 4 三视角 Review 视角 3 P2 发现 6 自修：用 resolveDedupDomain 统一三处 fallback 链
  try {
    const wc = webContentsMap.get(tabId) ?? null
    const dedupDomain = resolveDedupDomain(wc, { hintDomain: args.domain, credentialUrl: args.url })
    if (dedupDomain) {
      recordRecentSubmit(hashPasswordShort(args.password), dedupDomain)
    }
  } catch (err) {
    log.warn('recordRecentSubmit failed:', err)
  }

  emitSavePrompt({
    tabId,
    mode: args.mode,
    domain: args.domain,
    url: args.url,
    username: args.username,
    ...(args.credentialId ? { credentialId: args.credentialId } : {}),
    ...(args.existingUsernames ? { existingUsernames: args.existingUsernames } : {}),
  })
}

function emitSavePrompt(payload: SavePromptPayload): void {
  if (savePromptEmitter) {
    savePromptEmitter(payload)
    return
  }
  // 保存条必须盖在浏览器网页（原生 WebContentsView）之上，主 renderer 的 DOM
  // 盖不住原生层（见  overlay 方案 Y）。且保存条有可点按钮，必须跑在
  // focusable 的 modal 子窗口（toast 子窗口整窗穿透 + 非激活，按钮点不了）。
  // save-prompt 直接发给 modal 子窗口 webContents（同一个 preload，
  // credentialVault.onSavePrompt / saveConfirm 等在子窗口里同样可用）；modal 的
  // show/hide 由子窗口 renderer 按"是否有可见内容"通过 setModalSourceOpen('save-password', ...) 驱动。
  // 注意：modal 窗口即使当前 hidden，其 webContents 仍在运行、能收 IPC 并渲染，
  // renderer 收到后再驱动 show，时序安全。
  const modalContents = getModalWindowManager().getWebContents()
  if (!modalContents || modalContents.isDestroyed()) {
    log.warn('no modal overlay window available, save prompt dropped')
    return
  }
  modalContents.send('credential-vault:save-prompt', payload)
}

export function registerAutofillHandlers(): void {
  guardedHandle('credential-vault:autofill-select', async (
    _event,
    payload: { tabId: string; credentialId: string }
  ) => {
    traceAutofill('IPC autofill-select 被调用（用户点了某条凭据）', { tabId: payload.tabId })
    const webContents = webContentsMap.get(payload.tabId)
    if (!webContents || webContents.isDestroyed()) {
      return { success: false, error: 'WebContents not found or destroyed' }
    }

    if (!credentialRevealFn) {
      return { success: false, error: 'Credential reveal function not configured' }
    }

    try {
      const credential = await credentialRevealFn(payload.credentialId)
      if (!credential) {
        return { success: false, error: 'Credential not found' }
      }

      const filled = await fillLoginForm(webContents, credential.username, credential.password, credential.url)

      // Wave 3 修正版 Review 视角 1 P0 自修：autofill 把已存密码填入页面后，
      // 用户/Agent 点击登录按钮会触发 PASSWORD_CAPTURE_SCRIPT 的 click 信号
      // 上报同密码——这次"capture"其实是 autofill 的回声，**不应**走保存
      // 决策（已存凭据走 update 路径，若 plaintext 拉取失败会误把同密码当
      // 成"密码变了"弹"更新"提示，甚至静默改写）。
      //
      // 修复：fill 成功后，把该密码 hash 入 recentSubmits 队列，30s 内同
      // hash 在该 domain（或其他 domain）的 capture 都会被去重。
      if (filled) {
        // Wave 4 三视角 Review 视角 3 P2 发现 6 自修：用 resolveDedupDomain 统一三处 fallback 链
        try {
          const dedupDomain = resolveDedupDomain(webContents, { credentialUrl: credential.url })
          if (dedupDomain) {
            recordRecentSubmit(hashPasswordShort(credential.password), dedupDomain)
          }
        } catch (err) {
          log.warn('recordRecentSubmit (autofill) failed:', err)
        }

        // Wave 5a (L-W4-4)：autofill-select（用户前台 view 主动选凭据）路径
        // 也调 mark-used 保持一致性。trade-off：用户已经主动点了 overlay 选
        // 此凭据，意图比 Agent 后台 view 自动选强；即便后续手动 submit 失败，
        // 也是用户主动操作的轨迹，写入 last_used_at 的污染面相对小。
        // 失败 / 限流静默 —— 用户已经看到 fill 成功，UX 不受影响。
        if (markCredentialUsedFn) {
          try {
            await markCredentialUsedFn(payload.credentialId)
          } catch (err) {
            log.warn('markCredentialUsedFn (autofill-select) failed:', err)
          }
        }
      }

      return { success: filled }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  guardedHandle('credential-vault:autofill-dismiss', async (_event, payload: { tabId: string }) => {
    traceAutofill('IPC autofill-dismiss 被调用（X 关闭建议）', { tabId: payload.tabId })
    // Wave 3 修正版 Review 视角 3 P0-1 自修：dismiss 时所有相关 map 必须
    // 一致清理。旧实现只删 webContentsMap，遗留的 inPageNavMap 项会被
    // wc 后续的 did-navigate-in-page 监听写入，造成 verifyLoginSuccess
    // 读到不该读的历史时间戳 → 误判成功。
    //
    // Wave 3 三视角 Review 视角 3 P1 发现 2 自修：
    //   旧实现只删 inPageNavListeners 字典项，但 listener 还**实际挂在
    //   webContents 上**——只要 wc 没销毁（用户没关 tab，只是关了 autofill
    //   suggestion），后续 hash 跳转 / pushState 会触发 handler，handler
    //   内部 `else inPageNavMap.set(tabId, { lastInPageNavAt: Date.now() })`
    //   主动**重建**已删的 inPageNavMap 项 → 同 tabId 复用时新 wc 的
    //   verifyLoginSuccess 读到旧 wc 的历史时间戳 → 误判成功。
    //
    //   修复：拿到 wc 与 handler 引用，主动 `removeListener` 摘掉，再清
    //   字典项。这样 handler 不会再被触发，inPageNavMap 永远不会被孤立的
    //   旧 listener 重建。
    const wc = webContentsMap.get(payload.tabId)
    const handler = inPageNavListeners.get(payload.tabId)
    if (wc && handler && !wc.isDestroyed()) {
      try {
        wc.removeListener('did-navigate-in-page', handler)
      } catch (err) {
        log.warn('dismiss removeListener did-navigate-in-page 失败:', err)
      }
    }
    webContentsMap.delete(payload.tabId)
    inPageNavMap.delete(payload.tabId)
    lastSuggestUrlByTab.delete(payload.tabId)
    inPageNavListeners.delete(payload.tabId)
    return { success: true }
  })

  // ── Wave 3 G3：密码捕获 + 保存确认 + 黑名单 IPC handlers ──

  // 1. 密码捕获事件（preload → main）
  //
  // **不能用 guardedHandle**（Wave 3 P0 视角 1#1 + 视角 3#1）：
  //   guardedHandle 走 isTrustedSender 只信 file:// / ELECTRON_RENDERER_URL，
  //   而本 channel 的合法 sender 是 TabWeb 内 BrowserView 加载的真实外部页
  //   （https://github.com/login 等），永远会被拒绝 → Wave 3 在生产环境完
  //   全失效。
  //
  // **专用 sender 校验**（替代默认 isTrustedSender）：
  //   1. sender 必须**已经被 onViewDomReady 注册到 webContentsMap**——这意味
  //      着它是 view-factory 创建并经过 ViewStateRegistry dom-ready 链路的合
  //      法 crawl view，不是任意 webContents（如 Tin 沙箱、第三方 webview）；
  //   2. **永远忽略 payload.url**（视角 1#2 投毒）：URL 由主进程从 sender.
  //      getURL() 取，preload 端也已不再传 url（双保险）；
  //   3. **删除 fallback 注册分支**（视角 1#4）：找不到 sender 直接 return，
  //      不再无差别注册任意 webContents 留下攻击面。
  ipcMain.handle('credential-vault:password-captured', async (
    event: IpcMainInvokeEvent,
    payload: { url?: string; username?: string; password?: string },
  ) => {
    try {
      // ── 严格 sender 校验（替代 isTrustedSender）──
      let tabId: string | null = null
      for (const [id, wc] of webContentsMap.entries()) {
        if (wc === event.sender) {
          tabId = id
          break
        }
      }
      if (!tabId) {
        // sender 不是合法 crawl view → 拒绝（不打 url，避免 sender 控制日志内容）
        log.warn(
          'password-captured rejected: sender not registered in webContentsMap',
          { senderId: event.sender.id },
        )
        return { success: false, error: 'untrusted sender' }
      }

      // ── 入参校验（payload.url 被强制忽略，由主进程从 sender 取）──
      if (typeof payload?.password !== 'string' || !payload.password) {
        return { success: false, error: 'password required' }
      }
      const username = typeof payload.username === 'string' ? payload.username : ''
      // **关键安全约定**：URL 来自主进程 sender.getURL()，永远不信 payload.url
      const realUrl = event.sender.getURL()
      if (!realUrl) {
        return { success: false, error: 'sender URL unavailable' }
      }

      void onPasswordSubmitted(tabId, {
        url: realUrl,
        username,
        password: payload.password,
      })
      return { success: true }
    } catch (err: any) {
      log.warn('password-captured handler error:', err?.message)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  // 2. 保存确认（renderer → main）
  //
  // 安全设计：renderer 只发 tabId。密码从主进程 pendingSavePasswords 取，
  // 拿出来立即从 map 删掉。这样密码全程不进 renderer。
  guardedHandle('credential-vault:save-confirm', async (
    _event,
    payload: { tabId: string },
  ) => {
    if (!payload?.tabId) return { success: false, error: 'tabId required' }
    const pending = pendingSavePasswords.get(payload.tabId)
    if (!pending || pending.expiresAt < Date.now()) {
      pendingSavePasswords.delete(payload.tabId)
      return { success: false, error: 'pending save expired or not found' }
    }
    // 取出后立即从 map 删除（防止 race / 重复点）
    pendingSavePasswords.delete(payload.tabId)

    try {
      if (pending.mode === 'update' && pending.credentialId) {
        // PUT /credential-vault/{id}
        const result = await djangoPut(`/credential-vault/${pending.credentialId}`, {
          credential_data: {
            url: pending.url,
            username: pending.username,
            password: pending.password,
          },
        })
        if (!result) return { success: false, error: 'update failed' }
        return { success: true, mode: 'update' }
      }
      // save / new-account → POST /credential-vault/website/create
      const result = await djangoPost('/credential-vault/website/create', {
        url: pending.url,
        username: pending.username,
        password: pending.password,
      })
      if (!result) return { success: false, error: 'create failed' }
      return { success: true, mode: pending.mode, data: result }
    } catch (error: any) {
      return { success: false, error: error?.message || 'unknown error' }
    }
  })

  // 3. 加入黑名单（renderer → main）
  guardedHandle('credential-vault:save-dismiss', async (_event, payload: { domain: string }) => {
    if (!payload?.domain) return { success: false, error: 'domain required' }
    try {
      const result = await djangoPost('/credential-vault/save-blacklist', { domain: payload.domain })
      if (!result || (result as any).success === false) {
        return { success: false, error: (result as any)?.error || 'blacklist add failed' }
      }
      // 立即更新本地缓存
      blacklistCache.set(payload.domain, { blacklisted: true, cachedAt: Date.now() })
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message || 'unknown error' }
    }
  })

  // 4. 撤回黑名单（renderer → main）—— Wave 3 P0 视角 2#1 修复
  //
  // 用户在 SavePasswordBar 点了"不为此网站保存"后立即后悔的撤回入口（5s
  // 内可点）。Wave 5 设置页另有"已屏蔽列表"管理（不在 Wave 3 范围）。
  //
  // 同时把 cache 立即 invalidate 让下一次密码提交能再次弹保存条（不用等
  // 5min TTL 漂移结束）。
  guardedHandle('credential-vault:save-undismiss', async (_event, payload: { domain: string }) => {
    if (!payload?.domain) return { success: false, error: 'domain required' }
    try {
      const result = await djangoDelete(`/credential-vault/save-blacklist/${encodeURIComponent(payload.domain)}`)
      // DELETE 返回 {success: true} 也算成功；返回 null 视为后端不可达
      if (result === null) {
        return { success: false, error: 'blacklist remove failed (network)' }
      }
      // 立即清本地缓存（防止 5min 漂移）
      blacklistCache.delete(payload.domain)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error?.message || 'unknown error' }
    }
  })
}

async function djangoGet(path: string): Promise<any> {
  try {
    const accessToken = await TokenManager.getAccessToken()
    if (!accessToken) return null

    const url = new URL(joinApiPath(API_BASE_URL, path))
    const transport = url.protocol === 'https:' ? https : http

    return await new Promise((resolve) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              log.warn(`djangoGet ${path} -> HTTP ${status}`)
              resolve(null)
              return
            }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
            catch { resolve(null) }
          })
        }
      )
      req.on('error', (err) => { log.error('djangoGet error:', err); resolve(null) })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.end()
    })
  } catch (err) {
    log.error('djangoGet error:', err)
    return null
  }
}

async function djangoRequest(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: any): Promise<any> {
  try {
    const accessToken = await TokenManager.getAccessToken()
    if (!accessToken) return null

    const url = new URL(joinApiPath(API_BASE_URL, path))
    const transport = url.protocol === 'https:' ? https : http
    const bodyStr = body !== undefined ? JSON.stringify(body) : ''

    return await new Promise((resolve) => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      }
      if (bodyStr) headers['Content-Length'] = String(Buffer.byteLength(bodyStr))
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              log.warn(`django${method} ${path} -> HTTP ${status}`)
              resolve(null)
              return
            }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
            catch { resolve(null) }
          })
        }
      )
      req.on('error', (err) => { log.error(`django${method} error:`, err); resolve(null) })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  } catch (err) {
    log.error(`django${method} error:`, err)
    return null
  }
}

async function djangoPut(path: string, body: any): Promise<any> {
  return djangoRequest('PUT', path, body)
}

async function djangoDelete(path: string): Promise<any> {
  return djangoRequest('DELETE', path)
}

async function djangoPost(path: string, body: any): Promise<any> {
  try {
    const accessToken = await TokenManager.getAccessToken()
    if (!accessToken) return null

    const url = new URL(joinApiPath(API_BASE_URL, path))
    const transport = url.protocol === 'https:' ? https : http
    const bodyStr = JSON.stringify(body)

    return await new Promise((resolve) => {
      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'Content-Length': String(Buffer.byteLength(bodyStr)),
          },
          timeout: 10000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status < 200 || status >= 300) {
              log.warn(`djangoPost ${path} -> HTTP ${status}`)
              resolve(null)
              return
            }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))) }
            catch { resolve(null) }
          })
        }
      )
      req.on('error', (err) => { log.error('djangoPost error:', err); resolve(null) })
      req.on('timeout', () => { req.destroy(); resolve(null) })
      req.write(bodyStr)
      req.end()
    })
  } catch (err) {
    log.error('djangoPost error:', err)
    return null
  }
}

/**
 * 初始化 autofill service — 连接 Django credential API。
 * 在 registerCredentialVaultHandlers 中调用。
 */
export function initAutofillService(): void {
  setCredentialMatchFn(async (domain: string) => {
    const data = await djangoGet(`/credential-vault/website/match?domain=${encodeURIComponent(domain)}`)
    if (!Array.isArray(data)) return []
    return data.map((item: any) => ({
      id: item.id,
      url: item.url,
      username: item.username,
      masked_password: item.masked_password,
    }))
  })

  setCredentialRevealFn(async (credentialId: string) => {
    const win = BrowserWindow.getFocusedWindow()
      ?? BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
      ?? null
    const isZh = app.getLocale().toLowerCase().startsWith('zh')
    const msgOptions = {
      type: 'warning' as const,
      buttons: isZh ? ['允许填充', '取消'] : ['Allow', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: isZh ? '自动填充确认' : 'Autofill Confirmation',
      message: isZh ? '是否允许自动填充密码？' : 'Allow password autofill?',
      detail: isZh
        ? '此操作将使用保存的密码自动填充当前登录表单。'
        : 'This will use a saved password to autofill the current login form.',
    }

    const { response } = win
      ? await dialog.showMessageBox(win, msgOptions)
      : await dialog.showMessageBox(msgOptions)

    if (response !== 0) return null

    const data = await djangoPost(`/credential-vault/website/${credentialId}/autofill-reveal`, {})
    if (!data || !data.success) return null
    return data.data as { url: string; username: string; password: string }
  })

  // Wave 3 G2 + Wave 4 H2 共用：无交互的明文获取（不弹 dialog）。
  //
  // 两个用途共用一个端点 + 同一限流配额 + 同一错误语义（410 expired/inactive、
  // 401 token、网络失败）：
  //   - ``credentialFetchPlaintextFn`` 用于 ``onPasswordSubmitted`` 中 update
  //     路径的密码比对（输入：用户已知凭据；输出：明文比 == 当前提交）；
  //   - ``revealForAutofillWithoutDialogFn`` 用于 Agent 后台 view fill 路径
  //     （输入：autofill suggest 命中的凭据；输出：plaintext 直接喂 fillLoginForm）。
  //
  // **三视角 Review 视角 3 P1 发现 3 自修（DRY）**：
  //   原本两个 setter 各装一份字面量等价的 default 实现 + 一段"职责清晰"的
  //   注释——典型"用注释代替抽象"的反模式。重构成同一个内部函数，单测/E2E
  //   仍然可以独立 mock 任一注入器，但生产路径只维护一处实现。
  const fetchPlaintextWithoutDialog = async (
    credentialId: string,
  ): Promise<{ url: string; username: string; password: string } | null> => {
    const data = await djangoPost(`/credential-vault/website/${credentialId}/autofill-reveal`, {})
    if (!data || !data.success) return null
    return data.data as { url: string; username: string; password: string }
  }
  setCredentialFetchPlaintextFn(fetchPlaintextWithoutDialog)
  setRevealForAutofillWithoutDialogFn(fetchPlaintextWithoutDialog)

  // Wave 5a (L-W4-4)：注入默认 mark-used 实现 —— 走后端
  // ``POST /credential-vault/website/{id}/mark-used``。仅在 fill+submit+verify
  // 全成功后调用（``runAgentAutofill`` 内部接线）。
  setMarkCredentialUsedFn(async (credentialId: string) => {
    try {
      const data = await djangoPost(
        `/credential-vault/website/${credentialId}/mark-used`,
        {},
      )
      return Boolean(data?.success)
    } catch (err) {
      log.warn('markCredentialUsedFn default impl error:', err)
      return false
    }
  })

  // Wave 4 H1：注入"按 tabId 反查 view 元数据"的解析器。
  //
  // 默认实现走 ViewFactory.getViewState；resolver 内部所有 throw 都被
  // setViewClassificationFn 调用方捕获 → 降级走前台路径（保守、不破坏 Wave 3 行为）。
  setViewClassificationFn((tabId: string) => {
    try {
      const state = getViewFactory().getViewState(tabId)
      if (!state) return null
      const cfg = state.config
      return {
        displayMode: cfg?.displayMode,
        profile: cfg?.profile,
        runId: cfg?.runId || undefined,
        showInSidebar: cfg?.showInSidebar,
        spaceId: cfg?.spaceId || undefined,
      } as ViewClassification
    } catch (err) {
      // ViewFactory 未初始化（启动期）或 tabId 不存在 → 降级前台路径
      return null
    }
  })

  // Wave 3 G5：黑名单查询（带 5min 本地缓存）
  setBlacklistCheckFn(async (domain: string) => {
    const data = await djangoGet(`/credential-vault/save-blacklist`)
    if (!Array.isArray(data)) return false
    return data.some((item: any) => typeof item?.domain === 'string' && item.domain.toLowerCase() === domain.toLowerCase())
  })
}

/** 暴露给单测/E2E 用（不属于公开 API） */
export const __internals = {
  djangoGet,
  djangoPost,
  djangoPut,
  djangoDelete,
  webContentsMap,
}
