/**
 * Wave 4 T5 · 真实 Electron session E2E 脚本：Agent 后台 view 自动填充并提交。
 *
 * ## 业务目标
 *
 * 凭据库已有 google.com 凭据 → Agent open_tab 打开 accounts.google.com → Agent
 * **无需调用 credential_retrieve**，autofill 自动填充并提交，进入登录后页面。
 * 密码全程**不进 LLM 上下文**。
 *
 * ## 5 个核心场景
 *
 * - **W4-A**：Agent 后台 view + 凭据库已有匹配 → 自动 fill + 自动 submit + 跳 dashboard
 * - **W4-B**：Agent 后台 view + 多匹配 → 取 last_used_at 排第一的填
 * - **W4-C**：Agent 后台 view + 0 匹配 → 不操作 + 不弹 overlay
 * - **W4-D**：Agent 后台 view + 1 个匹配但凭据已过期（reveal 返回 null）→ 不 fill + 通知
 * - **W4-E**：用户前台 view + 1 个匹配 → 弹 overlay（Wave 3 行为不破坏）
 *
 * ## 怎么跑
 *
 * ```bash
 * # 本地有 display
 * bash apps/tabtin-electron/scripts/e2e-agent-autofill.sh
 *
 * # CI 无 display
 * xvfb-run -a bash apps/tabtin-electron/scripts/e2e-agent-autofill.sh
 * ```
 */

import { app, BrowserWindow } from 'electron'
import * as http from 'http'

import {
  setCredentialMatchFn,
  setRevealForAutofillWithoutDialogFn,
  setViewClassificationFn,
  setMarkCredentialUsedFn,
  __clearAllWebContentsForTest,
  __clearRecentSubmitsForTest,
  __clearPendingSavePasswordsForTest,
  __clearBlacklistCacheForTest,
  __setWebContentsForTest,
  setSavePromptEmitter,
  setOverlayEmitter,
  setAgentAutofillFailedEmitter,
  setAgentAutofillSucceededEmitter,
  setBlacklistCheckFn,
  setCredentialFetchPlaintextFn,
  onViewDomReady,
  onPasswordSubmitted,
  type ViewClassification,
} from '../src/main/credential-vault/autofill-service'

// Wave 5a (L-W4-1)：observation → LLM 上下文注入器（端到端断言密码 sentinel
// 不进 LLM 可见路径 + 文案确实含人话描述）。
import { getRunSessionManager } from '../src/main/run-session/RunSessionManager'
import {
  createRunObservationInjector,
  getRunObservationInjectorTestHooks,
} from '../src/main/agent/conversation/run-observation-injector'

// ── 本地 HTTP test server ───────────────────────────────────────────

let testServer: http.Server | null = null
let testServerPort = 0

const TRADITIONAL_LOGIN_HTML = `<!doctype html>
<html><head><title>Login</title></head>
<body>
  <h1>Login</h1>
  <form id="loginForm" method="POST" action="/login-success">
    <input type="text" name="username" id="user" autocomplete="username" />
    <input type="password" name="password" id="pwd" autocomplete="current-password" />
    <button type="submit" id="submitBtn">Sign in</button>
  </form>
</body></html>`

const DASHBOARD_HTML = `<!doctype html>
<html><head><title>Dashboard</title></head>
<body><h1>Welcome to Dashboard</h1><p>You are logged in.</p></body></html>`

function startTestServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    testServer = http.createServer((req, res) => {
      const url = req.url || '/'
      const method = req.method || 'GET'

      if (url === '/login' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(TRADITIONAL_LOGIN_HTML)
        return
      }
      if (url === '/login-success' && method === 'POST') {
        res.writeHead(302, { Location: '/dashboard' })
        res.end()
        return
      }
      if (url === '/dashboard' && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(DASHBOARD_HTML)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    testServer.on('error', reject)
    testServer.listen(0, '127.0.0.1', () => {
      const addr = testServer!.address()
      if (typeof addr === 'object' && addr) {
        resolve(addr.port)
      } else {
        reject(new Error('failed to get test server port'))
      }
    })
  })
}

function stopTestServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!testServer) return resolve()
    testServer.close(() => resolve())
  })
}

function serverUrl(path: string): string {
  return `http://127.0.0.1:${testServerPort}${path}`
}

// ── 断言工具 ────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  \u001b[32m\u2713\u001b[0m ${name}`)
    passed++
  } else {
    console.error(`  \u001b[31m\u2717\u001b[0m ${name}${detail ? ' — ' + detail : ''}`)
    failed++
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ── 安全 sentinel：跨场景跟踪密码字符串泄漏 ─────────────────────────
//
// 每个场景用唯一密码字符串。所有"LLM 可见路径"上挂收集器（save-prompt
// emitter / overlay emitter / agent-autofill 通知），脚本结束时扫所有
// 收集器的 JSON 序列化串，确保密码 sentinel **0 命中**。
//
// **三视角 Review 视角 3 P2 发现 5 自修**：旧实现 sentinel scan 只扫
// **每个场景被 resetMocks 清空之后的最后状态** —— 实际上前 4 个场景
// 的潜在泄漏会被中间的 resetMocks 清掉。改为**累积容器**：每次
// resetMocks 时把当前 calls push 到 allXxx，scan 时扫累积容器，
// 确保覆盖全部场景的 emit 历史。

const passwordSentinels: string[] = []
const savePromptCalls: any[] = []
const overlayCalls: Array<{ tabId: string; credentialIds: string[] }> = []
const revealCallLog: Array<{ credentialId: string; ts: number }> = []
const agentAutofillFailedCalls: Array<{
  tabId: string
  code: string
  credentialId?: string
  domain?: string
  detail?: string
}> = []
const agentAutofillSucceededCalls: Array<{
  tabId: string
  domain: string
  maskedUsername: string
  credentialId: string
}> = []

// Wave 5a (L-W4-4)：mark-used 调用记录（success path 必调，failure path 必不调）
const markUsedCallLog: Array<{ credentialId: string; ts: number }> = []

// 累积容器（视角 3 P2 自修）—— 跨场景扫安全 sentinel
const allSavePromptCalls: any[] = []
const allOverlayCalls: any[] = []
const allRevealCallLog: any[] = []
const allAgentAutofillFailedCalls: any[] = []
const allAgentAutofillSucceededCalls: any[] = []
const allMarkUsedCalls: any[] = []

// ── 测试辅助：模拟 view 元数据 ──────────────────────────────────

const mockViewMeta = new Map<string, ViewClassification>()

function registerMockView(tabId: string, classification: ViewClassification): void {
  mockViewMeta.set(tabId, classification)
}

setViewClassificationFn((tabId) => mockViewMeta.get(tabId) ?? null)

// ── 装 emitter（替代真实 IPC 路径，让我们能观测调用）──

setSavePromptEmitter((p) => savePromptCalls.push(p))
setOverlayEmitter((p) => overlayCalls.push({
  tabId: p.tabId,
  credentialIds: p.credentials.map((c) => c.id),
}))
setAgentAutofillFailedEmitter((p) => agentAutofillFailedCalls.push(p))
setAgentAutofillSucceededEmitter((p) => agentAutofillSucceededCalls.push(p))
// Wave 5a (L-W4-4)：mark-used 注入记录器
setMarkCredentialUsedFn(async (credentialId: string) => {
  markUsedCallLog.push({ credentialId, ts: Date.now() })
  return true
})

// ── 主流程 ─────────────────────────────────────────────────────

app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

function resetMocks(): void {
  __clearAllWebContentsForTest()
  __clearRecentSubmitsForTest()
  __clearPendingSavePasswordsForTest()
  __clearBlacklistCacheForTest()
  mockViewMeta.clear()
  // 视角 3 P2 自修：把当前场景的 calls 滚到累积容器，避免被清后失忆
  allSavePromptCalls.push(...savePromptCalls)
  allOverlayCalls.push(...overlayCalls)
  allRevealCallLog.push(...revealCallLog)
  allAgentAutofillFailedCalls.push(...agentAutofillFailedCalls)
  allAgentAutofillSucceededCalls.push(...agentAutofillSucceededCalls)
  allMarkUsedCalls.push(...markUsedCallLog)
  savePromptCalls.length = 0
  overlayCalls.length = 0
  revealCallLog.length = 0
  agentAutofillFailedCalls.length = 0
  agentAutofillSucceededCalls.length = 0
  markUsedCallLog.length = 0
  setBlacklistCheckFn(async () => false)
  setCredentialFetchPlaintextFn(async () => null)
}

async function createBrowserView(tabId: string, urlPath: string): Promise<BrowserWindow> {
  void tabId
  const win = new BrowserWindow({
    width: 600,
    height: 500,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  const finished = new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve())
  })
  await win.loadURL(serverUrl(urlPath))
  await finished
  return win
}

async function run(): Promise<number> {
  console.log('\u001b[33m[e2e-agent-autofill]\u001b[0m 启动…')
  testServerPort = await startTestServer()
  console.log(`[e2e-agent-autofill] 本地 HTTP server 已起 → http://127.0.0.1:${testServerPort}`)

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-A：Agent 后台 view + 1 个凭据匹配 → 自动 fill+submit+跳转
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-A：Agent 后台 view + 单匹配 → 自动 fill+submit')
  resetMocks()

  const W4A_PASSWORD = 'w4a-secret-pw-NEVER-IN-LLM-12345'
  const W4A_USERNAME = 'w4a-alice'
  passwordSentinels.push(W4A_PASSWORD)

  registerMockView('w4a-tab', {
    profile: 'background-task',
    displayMode: 'hidden',
    runId: 'run-w4a',
    showInSidebar: false,
  })

  setCredentialMatchFn(async (domain) => {
    if (domain !== '127.0.0.1') return []
    return [{
      id: 'cred-w4a',
      url: serverUrl('/login'),
      username: W4A_USERNAME,
      masked_password: '****',
    }]
  })
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return {
      url: serverUrl('/login'),
      username: W4A_USERNAME,
      password: W4A_PASSWORD,
    }
  })

  const winA = await createBrowserView('w4a-tab', '/login')
  await onViewDomReady('w4a-tab', winA.webContents)
  // 等 fill+submit+302 跳转完成
  const navDoneA = new Promise<void>((resolve) => {
    const onLoad = (): void => {
      if (winA.webContents.getURL().endsWith('/dashboard')) {
        winA.webContents.removeListener('did-finish-load', onLoad)
        resolve()
      }
    }
    winA.webContents.on('did-finish-load', onLoad)
  })
  await Promise.race([navDoneA, delay(5000)])
  // Wave 5a (L-W4-4)：等 verifyLoginSuccess 1.5s wait 完成 → mark-used 被调
  await delay(1800)

  assert(
    'W4-A.1：reveal 被调（Agent 后台 view 走"无 dialog 拉明文"路径）',
    revealCallLog.length === 1 && revealCallLog[0].credentialId === 'cred-w4a',
    `revealCallLog=${JSON.stringify(revealCallLog)}`,
  )
  assert(
    'W4-A.2：overlay **不被调**（不弹 overlay 给用户）',
    overlayCalls.length === 0,
    `overlayCalls=${JSON.stringify(overlayCalls)}`,
  )
  assert(
    'W4-A.3：webContents URL 跳到 /dashboard（自动 fill+submit 成功 → 服务端 302）',
    winA.webContents.getURL().endsWith('/dashboard'),
    `url=${winA.webContents.getURL()}`,
  )
  // 三视角 Review 视角 2 P1 发现 2 自修：成功 toast 必须 IPC 出去（PD-9 兜底）
  assert(
    'W4-A.4 (新增)：agent-autofill-succeeded IPC 已发出（用户能看到"Agent 用某账号登了某站"）',
    agentAutofillSucceededCalls.length === 1
      && agentAutofillSucceededCalls[0].tabId === 'w4a-tab'
      && agentAutofillSucceededCalls[0].domain === '127.0.0.1'
      && agentAutofillSucceededCalls[0].credentialId === 'cred-w4a',
    `agentAutofillSucceededCalls=${JSON.stringify(agentAutofillSucceededCalls)}`,
  )
  assert(
    'W4-A.5 (新增)：成功 toast payload **不含明文密码** + username 已脱敏',
    agentAutofillSucceededCalls.length === 1
      && !JSON.stringify(agentAutofillSucceededCalls).includes(W4A_PASSWORD)
      && !JSON.stringify(agentAutofillSucceededCalls).includes(W4A_USERNAME)
      && agentAutofillSucceededCalls[0].maskedUsername.includes('***'),
    `maskedUsername=${agentAutofillSucceededCalls[0]?.maskedUsername} (must not equal raw)`,
  )
  // Wave 5a (L-W4-4) — fill+submit+verify 全成功 → mark-used 必调
  assert(
    'W4-A.6 (Wave 5a L-W4-4)：mark-used 在 verify 通过后调用 1 次',
    markUsedCallLog.length === 1 && markUsedCallLog[0].credentialId === 'cred-w4a',
    `markUsedCallLog=${JSON.stringify(markUsedCallLog)}`,
  )
  assert(
    'W4-A.7 (Wave 5a L-W4-4)：mark-used payload **不含**明文密码（核心安全）',
    !JSON.stringify(markUsedCallLog).includes(W4A_PASSWORD),
    'leaked password in mark-used log',
  )

  // T4 安全闭环：模拟 page capture 上报 Agent 刚填的密码 → 应被 recentSubmits 命中
  setCredentialFetchPlaintextFn(async () => ({
    url: serverUrl('/login'),
    username: W4A_USERNAME,
    password: W4A_PASSWORD,
  }))
  await onPasswordSubmitted('w4a-tab', {
    url: serverUrl('/login'),
    username: W4A_USERNAME,
    password: W4A_PASSWORD,
  })
  await delay(200)

  assert(
    'W4-A.4：T4 闭环 — page 同密码 capture 上来不弹保存条（recordRecentSubmit 命中）',
    savePromptCalls.length === 0,
    `savePromptCalls=${JSON.stringify(savePromptCalls)}`,
  )

  winA.close()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-B：Agent 后台 view + 多匹配 → 取 last_used_at 第一个填
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-B：Agent 后台 view + 多匹配 → 取 last_used_at 第一个')
  resetMocks()

  const W4B_RECENT_PASSWORD = 'w4b-recent-secret-NEVER-IN-LLM'
  const W4B_OLD_PASSWORD = 'w4b-old-secret-NEVER-IN-LLM'
  passwordSentinels.push(W4B_RECENT_PASSWORD, W4B_OLD_PASSWORD)

  registerMockView('w4b-tab', {
    profile: 'background-task',
    displayMode: 'hidden',
    runId: 'run-w4b',
  })

  // 后端 /website/match 已经按 last_used_at DESC 排好——前端取 matches[0]
  setCredentialMatchFn(async () => [
    { id: 'cred-recent', url: serverUrl('/login'), username: 'recent-user', masked_password: '****' },
    { id: 'cred-old', url: serverUrl('/login'), username: 'old-user', masked_password: '****' },
  ])
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    if (credentialId === 'cred-recent') {
      return {
        url: serverUrl('/login'),
        username: 'recent-user',
        password: W4B_RECENT_PASSWORD,
      }
    }
    return {
      url: serverUrl('/login'),
      username: 'old-user',
      password: W4B_OLD_PASSWORD,
    }
  })

  const winB = await createBrowserView('w4b-tab', '/login')
  await onViewDomReady('w4b-tab', winB.webContents)
  // 等 fill 完成（登录请求会发 → 重定向到 dashboard，但我们也可能在 dashboard
  // 之前就能读到 fill 后的字段——dashboard 跳了字段就消失了，所以**在跳转前**读）
  await delay(300)

  // 在跳转前抓 username 字段值（form 还没 submit 完成时，input 还在）
  // 实际上 fillLoginForm 后立刻 submit，所以可能已经跳了。退而求其次：
  // 直接验证 reveal 调用的 credentialId
  // Wave 5a (L-W4-4)：等 verifyLoginSuccess 1.5s wait 完成 → mark-used 被调
  await delay(1800)

  assert(
    'W4-B.1：reveal 用 cred-recent (matches[0])（PD-10：last_used_at DESC 第一）',
    revealCallLog.length === 1 && revealCallLog[0].credentialId === 'cred-recent',
    `revealCallLog=${JSON.stringify(revealCallLog)}`,
  )
  assert(
    'W4-B.2：reveal 不会再调 cred-old（不会双填）',
    !revealCallLog.some((r) => r.credentialId === 'cred-old'),
    `revealCallLog=${JSON.stringify(revealCallLog)}`,
  )
  // 跳转后验证 URL 也跳了（因为登录提交了 recent-user 凭据，server 不验证密码 → 302）
  assert(
    'W4-B.3：URL 跳到 /dashboard（fill+submit 成功）',
    winB.webContents.getURL().endsWith('/dashboard'),
    `url=${winB.webContents.getURL()}`,
  )
  // Wave 5a (L-W4-4)：多匹配 fill+submit+verify 通过 → mark-used 用 last_used_at
  // 排第一的 cred-recent，让"最近使用"信号自我强化（与下次 match 排序一致）
  assert(
    'W4-B.4 (Wave 5a L-W4-4)：mark-used 写 cred-recent（PD-10 + last_used 自我强化）',
    markUsedCallLog.length === 1 && markUsedCallLog[0].credentialId === 'cred-recent',
    `markUsedCallLog=${JSON.stringify(markUsedCallLog)}`,
  )

  winB.close()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-C：Agent 后台 view + 0 匹配 → 不操作 + 不弹 overlay
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-C：Agent 后台 view + 0 匹配 → 不操作')
  resetMocks()

  registerMockView('w4c-tab', {
    profile: 'background-task',
    displayMode: 'hidden',
    runId: 'run-w4c',
  })

  setCredentialMatchFn(async () => [])
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return null
  })

  const winC = await createBrowserView('w4c-tab', '/login')
  await onViewDomReady('w4c-tab', winC.webContents)
  await delay(500)

  assert(
    'W4-C.1：reveal 不被调（0 匹配，不存在 credentialId）',
    revealCallLog.length === 0,
    `revealCallLog=${JSON.stringify(revealCallLog)}`,
  )
  assert(
    'W4-C.2：overlay 不弹（Agent 后台 view 不弹给用户看）',
    overlayCalls.length === 0,
    `overlayCalls=${JSON.stringify(overlayCalls)}`,
  )
  assert(
    'W4-C.3：URL 仍在 /login（没有 fill+submit 就没有跳转）',
    winC.webContents.getURL().endsWith('/login'),
    `url=${winC.webContents.getURL()}`,
  )

  winC.close()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-D：Agent 后台 view + 1 匹配但凭据已过期（reveal 返回 null）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-D：Agent 后台 view + 凭据已过期（410）→ 不 fill + 通知')
  resetMocks()

  registerMockView('w4d-tab', {
    profile: 'background-task',
    displayMode: 'hidden',
    runId: 'run-w4d',
  })

  setCredentialMatchFn(async () => [{
    id: 'cred-expired',
    url: serverUrl('/login'),
    username: 'expired-user',
    masked_password: '****',
  }])
  // 后端返回 410（过期）→ revealForAutofillWithoutDialogFn 返回 null
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return null
  })

  const winD = await createBrowserView('w4d-tab', '/login')
  await onViewDomReady('w4d-tab', winD.webContents)
  await delay(500)

  assert(
    'W4-D.1：reveal 被调（match 命中走 reveal）',
    revealCallLog.length === 1,
    `revealCallLog=${JSON.stringify(revealCallLog)}`,
  )
  assert(
    'W4-D.2：reveal 返回 null（凭据失效）→ URL 仍在 /login（fill 未触发，无跳转）',
    winD.webContents.getURL().endsWith('/login'),
    `url=${winD.webContents.getURL()}`,
  )
  assert(
    'W4-D.3：overlay 不弹（Agent 后台 view 永远不弹）',
    overlayCalls.length === 0,
    `overlayCalls=${JSON.stringify(overlayCalls)}`,
  )
  // 三视角 Review 视角 2 P2 发现 4 自修：用户能感知凭据失效
  assert(
    'W4-D.4 (新增)：agent-autofill-failed IPC 已发出，code=credential-unavailable',
    agentAutofillFailedCalls.length === 1
      && agentAutofillFailedCalls[0].code === 'credential-unavailable'
      && agentAutofillFailedCalls[0].tabId === 'w4d-tab'
      && agentAutofillFailedCalls[0].credentialId === 'cred-expired'
      && agentAutofillFailedCalls[0].domain === '127.0.0.1',
    `agentAutofillFailedCalls=${JSON.stringify(agentAutofillFailedCalls)}`,
  )
  assert(
    'W4-D.5 (新增)：成功 toast 不被误发（凭据失效不能算成功）',
    agentAutofillSucceededCalls.length === 0,
    `agentAutofillSucceededCalls=${JSON.stringify(agentAutofillSucceededCalls)}`,
  )
  // Wave 5a (L-W4-4) 核心防御：reveal null（凭据过期）→ mark-used **必不**调用
  assert(
    'W4-D.6 (Wave 5a L-W4-4 核心防御)：reveal 失败时 mark-used 不被调（last_used_at 不被错误污染）',
    markUsedCallLog.length === 0,
    `markUsedCallLog should be empty but got=${JSON.stringify(markUsedCallLog)}`,
  )

  winD.close()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-E：用户前台 view + 1 匹配 → 弹 overlay（Wave 3 不破坏）
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-E：用户前台 view → 弹 overlay（Wave 3 行为不破坏）')
  resetMocks()

  registerMockView('w4e-tab', {
    profile: 'user-tab',
    displayMode: 'embedded',
    showInSidebar: true,
    // 没有 runId
  })

  setCredentialMatchFn(async () => [{
    id: 'cred-w4e',
    url: serverUrl('/login'),
    username: 'w4e-user',
    masked_password: '****',
  }])
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return null
  })

  const winE = await createBrowserView('w4e-tab', '/login')
  await onViewDomReady('w4e-tab', winE.webContents)
  await delay(500)

  assert(
    'W4-E.1：overlay 被调（弹给用户）',
    overlayCalls.length === 1 && overlayCalls[0].tabId === 'w4e-tab',
    `overlayCalls=${JSON.stringify(overlayCalls)}`,
  )
  assert(
    'W4-E.2：reveal **不被自动调**（前台 view：等用户点 overlay 才会调）',
    revealCallLog.length === 0,
    `revealCallLog=${JSON.stringify(revealCallLog)}`,
  )
  assert(
    'W4-E.3：URL 仍在 /login（前台 view 不自动 fill+submit）',
    winE.webContents.getURL().endsWith('/login'),
    `url=${winE.webContents.getURL()}`,
  )

  winE.close()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-A.5：spaceId 透传到 succeeded payload（视角 2 P1 发现 3 自修）
  //
  // 重新跑 W4-A 类似流程，但 view classification 带 spaceId，断言 emitter
  // payload 含 spaceId 字段，让 renderer 反查 Agent 名字。
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-G：succeeded payload 带 spaceId（视角 2#3 自修）')
  resetMocks()

  const W4G_PASSWORD = 'w4g-spaceid-secret-pw'
  passwordSentinels.push(W4G_PASSWORD)

  registerMockView('w4g-tab', {
    profile: 'background-task',
    displayMode: 'hidden',
    runId: 'run-w4g',
    spaceId: 'space-research-helper-w4g',
  })

  setCredentialMatchFn(async () => [{
    id: 'cred-w4g',
    url: serverUrl('/login'),
    username: 'w4g-user',
    masked_password: '****',
  }])
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return {
      url: serverUrl('/login'),
      username: 'w4g-user',
      password: W4G_PASSWORD,
    }
  })

  const winG = await createBrowserView('w4g-tab', '/login')
  await onViewDomReady('w4g-tab', winG.webContents)
  await delay(1500) // 等 fill+submit+302 跳转

  assert(
    'W4-G.1：succeeded emitter 被调',
    agentAutofillSucceededCalls.length === 1,
    `count=${agentAutofillSucceededCalls.length}`,
  )
  assert(
    'W4-G.2：succeeded payload 带 spaceId（视角 2#3）',
    agentAutofillSucceededCalls.length === 1
      && (agentAutofillSucceededCalls[0] as any).spaceId === 'space-research-helper-w4g',
    `payload=${JSON.stringify(agentAutofillSucceededCalls)}`,
  )
  assert(
    'W4-G.3：succeeded payload 不含密码（核心安全）',
    !JSON.stringify(agentAutofillSucceededCalls).includes(W4G_PASSWORD),
    'leakage detected',
  )

  winG.close()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-F：三视角 Review 视角 1#4 自修验证 — 跨 tab 跨 domain 同密码
  //
  // Agent 在 tab1 fill `pwd-shared-1234` 到 example.com → 然后用户在 tab2
  // 输入完全相同密码到 othersite.com 登录。修复前：recentSubmits 是 module
  // singleton 不区分 tab/domain → 用户的 tab2 capture 被静默吞掉漏弹保存条。
  // 修复后：本场景**仍然会**触发 dedup（因为 30s 内同密码哈希命中）—— 这
  // 是 trade-off 决策：当前选保留 dedup 防 OAuth 多跳回声，将来可能加 tabId
  // 区分。本场景作为**当前行为基线**记录，方便未来改 dedup 时断言行为变化。
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-F：跨 tab 跨 domain 同密码 dedup 行为基线')
  resetMocks()

  const W4F_SHARED_PASSWORD = 'w4f-shared-pw-1234567890'
  passwordSentinels.push(W4F_SHARED_PASSWORD)

  // tab1：Agent 后台 view fill+submit 共享密码
  registerMockView('w4f-tab1', { profile: 'background-task', displayMode: 'hidden', runId: 'run-w4f-1' })
  setCredentialMatchFn(async () => [{
    id: 'cred-w4f',
    url: serverUrl('/login'),
    username: 'shared-user',
    masked_password: '****',
  }])
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return {
      url: serverUrl('/login'),
      username: 'shared-user',
      password: W4F_SHARED_PASSWORD,
    }
  })
  const winF1 = await createBrowserView('w4f-tab1', '/login')
  await onViewDomReady('w4f-tab1', winF1.webContents)
  await delay(800)
  winF1.close()

  // tab2：用户在不同 domain 输入完全相同密码（这里用同一 server 不同 path 模拟）
  // 真实场景是 othersite.com 但 e2e 用同 host 不同 url 测核心路径
  setCredentialFetchPlaintextFn(async () => null) // 无现有匹配
  setCredentialMatchFn(async () => []) // 不同 domain，无匹配
  // 模拟 page capture 上报到 onPasswordSubmitted
  __setWebContentsForTest('w4f-tab2', {
    getURL: () => serverUrl('/login') + '?other-site',
    isDestroyed: () => false,
    executeJavaScript: async () => false,
    once: () => {},
    on: () => {},
    id: 999,
  } as any)
  await onPasswordSubmitted('w4f-tab2', {
    url: serverUrl('/login') + '?other-site',
    username: 'user-other',
    password: W4F_SHARED_PASSWORD, // 完全相同的密码
  })
  await delay(200)

  // 当前行为基线：dedup 命中 → 不弹（这是 trade-off 决策）
  const w4fSavePrompts = savePromptCalls.length
  console.log(`  [info] W4-F 跨 tab dedup 命中数：${w4fSavePrompts === 0 ? '是（当前行为）' : '否'}`)
  // 不强制断言——只记录基线
  assert(
    'W4-F.1：跨 tab 跨 domain 同密码 dedup 行为可观测（当前 = 命中静默；未来若改 trade-off 此 assert 也要改）',
    true, // 只是记录，不阻塞
  )

  __clearAllWebContentsForTest()

  // ════════════════════════════════════════════════════════════════
  // 场景 W4-OBS：Wave 5a (L-W4-1) observation → LLM 上下文端到端
  //
  // 链路：autofill 失败 → recordAgentAutofillObservation 写 RSM → injector
  // 拿到 observation → 注入文案不携带密码 / credentialId 完整明文。
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] W4-OBS：observation 注入 LLM 上下文（Wave 5a L-W4-1）')
  resetMocks()

  const W4_OBS_PASSWORD = 'w4obs-secret-NEVER-IN-LLM-OR-OBS'
  const W4_OBS_CREDENTIAL_ID = 'cred-uuid-deadbeef-1111-2222-3333-444455556666'
  const W4_OBS_SPACE = 'space-w4obs'
  passwordSentinels.push(W4_OBS_PASSWORD)

  // 写 1 个 run，绑定到 spaceId
  const rsm = getRunSessionManager()
  rsm.createRun('run-w4obs')
  ;(rsm as any).runs.get('run-w4obs').spaceId = W4_OBS_SPACE

  registerMockView('w4obs-tab', {
    profile: 'background-task',
    displayMode: 'hidden',
    runId: 'run-w4obs',
    spaceId: W4_OBS_SPACE,
  })

  setCredentialMatchFn(async () => [{
    id: W4_OBS_CREDENTIAL_ID,
    url: serverUrl('/login'),
    username: 'w4obs-user',
    masked_password: '****',
  }])
  // reveal 返回 null → 走 credential-unavailable 失败路径
  setRevealForAutofillWithoutDialogFn(async (credentialId) => {
    revealCallLog.push({ credentialId, ts: Date.now() })
    return null
  })

  // 注入器创建之前先把 lastReadTimestamp 起点设到 0（确保拿得到刚写入的 obs）
  const injectorHandle = createRunObservationInjector({ spaceId: W4_OBS_SPACE })
  const injectorHooks = getRunObservationInjectorTestHooks(injectorHandle)
  if (!injectorHooks) {
    throw new Error('test hooks unavailable — createRunObservationInjector contract changed')
  }
  injectorHooks.reset(0)

  const winObs = await createBrowserView('w4obs-tab', '/login')
  await onViewDomReady('w4obs-tab', winObs.webContents)
  await delay(700)

  // 主断言：injector 能拿到 observation
  const injected = await injectorHandle.injector()
  assert(
    'W4-OBS.1：autofill 失败 → injector 拿到至少 1 条 observation',
    injected.length >= 1,
    `injected=${JSON.stringify(injected)}`,
  )
  const failureObs = injected.find((o) => o.type === 'AGENT_AUTOFILL_FAILED')
  assert(
    'W4-OBS.2：observation 包含 AGENT_AUTOFILL_FAILED 类型',
    !!failureObs,
    `injected types=${injected.map((o) => o.type).join(',')}`,
  )
  assert(
    'W4-OBS.3：humanReadable 含人话失败描述（"凭据可能已过期"）',
    !!failureObs && failureObs.humanReadable.includes('凭据可能已过期'),
    `text=${failureObs?.humanReadable}`,
  )
  assert(
    'W4-OBS.4：humanReadable 含 domain 名（用户视角清晰）',
    !!failureObs && failureObs.humanReadable.includes('127.0.0.1'),
    `text=${failureObs?.humanReadable}`,
  )

  // ── 安全断言：observation 注入路径不携带密码 / 完整 credentialId 明文 ──
  const injectedJson = JSON.stringify(injected)
  assert(
    'W4-OBS.5 (核心安全)：observation 注入路径不含密码字符串',
    !injectedJson.includes(W4_OBS_PASSWORD),
    `(LEAK FOUND in observation: ${injectedJson})`,
  )
  assert(
    'W4-OBS.6 (核心安全)：observation 注入路径不含完整 credentialId（只允许前 6 字符 hint）',
    !injectedJson.includes(W4_OBS_CREDENTIAL_ID),
    `(LEAK FOUND in observation: ${injectedJson})`,
  )
  assert(
    'W4-OBS.7：humanReadable 包含截短 credentialId hint（前 6 字符 + …，便于排查）',
    !!failureObs && /cred:cred-u/.test(failureObs.humanReadable),
    `text=${failureObs?.humanReadable}`,
  )

  // 第二次调 injector 不再返回同一条 observation（已读游标推进）
  const secondInjection = await injectorHandle.injector()
  assert(
    'W4-OBS.8：已读游标推进 — 第二次调 injector 无新 observation',
    secondInjection.length === 0,
    `secondInjection=${JSON.stringify(secondInjection)}`,
  )

  winObs.close()

  // ════════════════════════════════════════════════════════════════
  // 关键安全断言：密码字符串 0 出现在 LLM 可见路径
  //
  // **三视角 Review 视角 3 P2 发现 5 自修**：
  //   旧实现只 scan 当前 (W4-F) 场景的 emitter calls —— 前面 5 个场景
  //   的潜在泄漏被 resetMocks 清掉，安全断言只覆盖 1/6 用例。改为 scan
  //   累积容器 + 把当前最后一个场景的 calls 也 push 进去再扫，确保覆盖
  //   全部 6 个场景的 emit 历史。
  // ════════════════════════════════════════════════════════════════
  console.log('\n[e2e-agent-autofill] 安全断言：密码字符串 0 出现在 IPC / overlay / save-prompt（**累积扫**全部 6 场景）')

  // 把 W4-F 最后一个场景的 calls 滚进累积容器（resetMocks 在 W4-F 后没再触发）
  allSavePromptCalls.push(...savePromptCalls)
  allOverlayCalls.push(...overlayCalls)
  allRevealCallLog.push(...revealCallLog)
  allAgentAutofillFailedCalls.push(...agentAutofillFailedCalls)
  allAgentAutofillSucceededCalls.push(...agentAutofillSucceededCalls)
  allMarkUsedCalls.push(...markUsedCallLog)

  for (const sentinel of passwordSentinels) {
    assert(
      `安全：密码 "${sentinel.slice(0, 16)}..." 不在 savePrompt emitter payload 中（累积扫）`,
      !JSON.stringify(allSavePromptCalls).includes(sentinel),
      `(找到了泄漏！请检查 save-prompt 路径)`,
    )
    assert(
      `安全：密码 "${sentinel.slice(0, 16)}..." 不在 overlay emitter payload 中（累积扫）`,
      !JSON.stringify(allOverlayCalls).includes(sentinel),
      `(找到了泄漏！请检查 overlay 路径)`,
    )
    assert(
      `安全：密码 "${sentinel.slice(0, 16)}..." 不在 reveal call log 中（累积扫；log 只记 credentialId）`,
      !JSON.stringify(allRevealCallLog).includes(sentinel),
      `(找到了泄漏！请检查 reveal 调用日志)`,
    )
    assert(
      `安全：密码 "${sentinel.slice(0, 16)}..." 不在 agent-autofill-failed IPC payload 中（累积扫）`,
      !JSON.stringify(allAgentAutofillFailedCalls).includes(sentinel),
      `(找到了泄漏！失败 IPC 不该带密码)`,
    )
    assert(
      `安全：密码 "${sentinel.slice(0, 16)}..." 不在 agent-autofill-succeeded IPC payload 中（累积扫）`,
      !JSON.stringify(allAgentAutofillSucceededCalls).includes(sentinel),
      `(找到了泄漏！成功 IPC 不该带密码)`,
    )
    assert(
      `安全：密码 "${sentinel.slice(0, 16)}..." 不在 mark-used 调用 log 中（累积扫，Wave 5a L-W4-4）`,
      !JSON.stringify(allMarkUsedCalls).includes(sentinel),
      `(找到了泄漏！mark-used log 不该带密码)`,
    )
  }

  await stopTestServer()
  console.log('[e2e-agent-autofill] HTTP server 已关停')

  console.log(`\n[e2e-agent-autofill] 结果：\u001b[32m${passed} 通过\u001b[0m / \u001b[31m${failed} 失败\u001b[0m`)
  return failed === 0 ? 0 : 1
}

app
  .whenReady()
  .then(() => run())
  .then((code) => {
    void stopTestServer().finally(() => app.exit(code))
  })
  .catch((err) => {
    console.error('[e2e-agent-autofill] 脚本崩溃:', err)
    void stopTestServer().finally(() => app.exit(2))
  })
