/**
 * TabTin Electron CDP 解析 — 读 DevToolsActivePort，经 browser WebSocket 驱动 renderer。
 *
 * 不硬编码 9222 / 不走 /json/list（Chrome 占 9222 时 /json/list 会 404）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_VITE_PORT = Number(process.env.VITE_DEV_SERVER_PORT || 5175)
const KNOWN_USER_DATA_DIR_NAMES = [
  'TabTin Dev',
  'TabTin Local',
  'TabTin Preprod',
  'TabTin',
  'tabtin-electron',
]

function electronAppDataDir() {
  const home = os.homedir()
  if (process.platform === 'darwin') {
    return path.join(home, 'Library/Application Support')
  }
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(home, 'AppData/Roaming')
  }
  return path.join(home, '.config')
}

function electronUserDataDirCandidates() {
  return KNOWN_USER_DATA_DIR_NAMES.map((name) => path.join(electronAppDataDir(), name))
}

export function getDevToolsActivePortPath() {
  return path.join(electronUserDataDirCandidates()[0], 'DevToolsActivePort')
}

function parseEnvPort() {
  const raw = process.env.TABTIN_CDP_ACTIVE_PORT
    ?? process.env.TABTIN_CDP_PORT
    ?? process.env.CDP_PORT
  if (!raw?.trim()) return undefined
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return port
}

/** @returns {{ port: number, browserPath: string, filePath: string, source: 'file' | 'env' } | null} */
export function readDevToolsActivePort() {
  const envPort = parseEnvPort()
  if (envPort) {
    return { port: envPort, browserPath: '', filePath: getDevToolsActivePortPath(), source: 'env' }
  }

  for (const userDataDir of electronUserDataDirCandidates()) {
    const filePath = path.join(userDataDir, 'DevToolsActivePort')
    if (!fs.existsSync(filePath)) continue
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)
    const port = Number(lines[0])
    const browserPath = lines[1]?.trim()
    if (Number.isInteger(port) && port > 0 && browserPath) {
      return { port, browserPath, filePath, source: 'file' }
    }
  }
  return null
}

/**
 * 向 http://127.0.0.1:<port>/json/version 取**实时** browser WebSocket。
 *
 * 这是判定「当前活着的 Electron 实例」的权威来源——DevToolsActivePort 文件在
 * 同端口重启后**不一定被重写**（Chromium 不刷新已存在的文件），缓存的旧 GUID
 * 会让探针连到已死的 endpoint。`/json/version`（注意不是 /json/list）即便在
 * Electron 上也稳定可用，且总是反映当前进程。
 *
 * @returns {Promise<string | null>} webSocketDebuggerUrl 或 null（取不到）
 */
async function fetchLiveBrowserWsUrl(port, { timeoutMs = 2000 } = {}) {
  if (typeof fetch === 'undefined') return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
    if (!res.ok) return null
    const data = await res.json()
    const wsUrl = typeof data?.webSocketDebuggerUrl === 'string' ? data.webSocketDebuggerUrl : null
    return wsUrl || null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveCdpEndpoint(overridePort) {
  const active = readDevToolsActivePort()
  const port = overridePort ?? active?.port
  if (!port) {
    throw new Error(
      `无法解析 Electron CDP 端口：请确认 Electron dev 在跑，或设置 TABTIN_CDP_PORT；` +
        `期望文件 ${getDevToolsActivePortPath()}`,
    )
  }
  if (overridePort && active?.port && active.port !== overridePort) {
    throw new Error(`端口 override ${overridePort} 与 DevToolsActivePort ${active.port} 不一致`)
  }

  // 权威优先：实时 /json/version。文件里的 browserPath 仅在 /json/version 取不到时兜底，
  // 因为同端口重启后文件可能 stale（旧 GUID）。
  const liveWsUrl = await fetchLiveBrowserWsUrl(port)
  if (liveWsUrl) {
    return {
      port,
      browserPath: new URL(liveWsUrl).pathname,
      browserWsUrl: liveWsUrl,
      filePath: active?.filePath ?? getDevToolsActivePortPath(),
      source: 'json-version',
    }
  }

  if (active?.browserPath) {
    return {
      port: active.port,
      browserPath: active.browserPath,
      browserWsUrl: `ws://127.0.0.1:${active.port}${active.browserPath}`,
      filePath: active.filePath,
      source: active.source,
    }
  }

  throw new Error(
    `无法解析 browser WebSocket（port=${port}）：/json/version 不可达且 DevToolsActivePort 无 browser 路径。` +
      `请确认 Electron dev 在该端口监听（${getDevToolsActivePortPath()}）`,
  )
}

function createCdpClient(ws, { commandTimeoutMs = 20000 } = {}) {
  let nextId = 1
  /** @type {Map<number, { resolve: (msg: any) => void, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data))
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id)
      pending.delete(msg.id)
      clearTimeout(entry?.timer)
      entry?.resolve(msg)
    }
  })

  return {
    send(method, params = {}, sessionId) {
      const id = nextId++
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(`CDP 超时 ${commandTimeoutMs}ms: ${method}`))
        }, commandTimeoutMs)
        pending.set(id, { resolve, timer })
        ws.send(JSON.stringify(payload))
      })
    },
  }
}

function openWebSocket(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`CDP WebSocket 连接超时 ${timeoutMs}ms: ${url}`))
    }, timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(ws)
    }, { once: true })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`CDP WebSocket 连接失败: ${url}`))
    }, { once: true })
  })
}

async function withBrowserSession(fn, { port, commandTimeoutMs } = {}) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('当前 Node 无内置 WebSocket（需 Node ≥ 21）。')
  }
  const endpoint = await resolveCdpEndpoint(port)
  const ws = await openWebSocket(endpoint.browserWsUrl)
  const client = createCdpClient(ws, { commandTimeoutMs })
  try {
    return await fn(client, endpoint)
  } finally {
    ws.close()
  }
}

function isTabtinPackagedPage(target) {
  const url = String(target.url || '')
  return url.startsWith('tabtin-file://app/')
}

function isTabtinDevPage(target, vitePort = DEFAULT_VITE_PORT) {
  const url = String(target.url || '')
  if (!url || url.startsWith('devtools://')) return false
  if (target.type !== 'page') return false
  return (
    url.includes(`localhost:${vitePort}`) ||
    url.includes(`127.0.0.1:${vitePort}`) ||
    isTabtinPackagedPage(target)
  )
}

function isModalDevPage(target, vitePort = DEFAULT_VITE_PORT) {
  if (!isTabtinDevPage(target, vitePort)) return false
  const url = String(target.url || '')
  return url.includes('overlay.html') && url.includes('role=modal')
}

function isToastDevPage(target, vitePort = DEFAULT_VITE_PORT) {
  if (!isTabtinDevPage(target, vitePort)) return false
  const url = String(target.url || '')
  return url.includes('overlay.html') && url.includes('role=toast')
}

function isOverlayDevPage(target, vitePort = DEFAULT_VITE_PORT) {
  if (!isTabtinDevPage(target, vitePort)) return false
  const url = String(target.url || '')
  return url.includes('overlay.html') && !url.includes('role=')
}

function isMainDevPage(target, vitePort = DEFAULT_VITE_PORT) {
  if (!isTabtinDevPage(target, vitePort)) return false
  const url = String(target.url || '')
  if (url.includes('overlay.html')) return false
  // packaged / preview:packaged 主页面是 tabtin-file://app/index.html
  if (isTabtinPackagedPage(target)) {
    return url.includes('/index.html') || url === 'tabtin-file://app/' || url.endsWith('://app')
  }
  return true
}

export async function listPageTargets({ port, vitePort = DEFAULT_VITE_PORT } = {}) {
  return withBrowserSession(async (client) => {
    await client.send('Target.setDiscoverTargets', { discover: true })
    const res = await client.send('Target.getTargets')
    const targets = res.result?.targetInfos ?? []
    return targets
      .filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'))
      .map((t) => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        isTabtin: isTabtinDevPage(t, vitePort),
      }))
  }, { port })
}

async function pickPageTarget(client, { page = 'main', vitePort = DEFAULT_VITE_PORT } = {}) {
  await client.send('Target.setDiscoverTargets', { discover: true })
  const res = await client.send('Target.getTargets')
  const targets = res.result?.targetInfos ?? []
  const pages = targets.filter((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools://'))

  if (page === 'modal') {
    const modal = pages.find((t) => isModalDevPage(t, vitePort))
    if (modal) return modal
    throw new Error(
      `未找到 modal 子窗口 renderer（期望 */overlay.html?role=modal on :${vitePort}）。` +
        `当前 pages: ${pages.map((p) => p.url).join(', ') || '(none)'}`,
    )
  }

  if (page === 'toast') {
    const toastPage = pages.find((t) => isToastDevPage(t, vitePort))
    if (toastPage) return toastPage
    throw new Error(
      `未找到 toast 子窗口 renderer（期望 */overlay.html?role=toast on :${vitePort}）。` +
        `当前 pages: ${pages.map((p) => p.url).join(', ') || '(none)'}`,
    )
  }

  if (page === 'overlay') {
    const overlay = pages.find((t) => isOverlayDevPage(t, vitePort))
    if (overlay) return overlay
    throw new Error(
      `未找到 overlay renderer（期望 */overlay.html on :${vitePort}）。` +
        `当前 pages: ${pages.map((p) => p.url).join(', ') || '(none)'}`,
    )
  }

  const main = pages.find((t) => isMainDevPage(t, vitePort))
  if (main) return main
  if (page === 'main' && pages.length === 1 && !isOverlayDevPage(pages[0], vitePort)) {
    return pages[0]
  }

  throw new Error(
    `未找到 TabTin 主 renderer page（期望 localhost:${vitePort} 或 tabtin-file://app/index.html，非 overlay.html）。` +
      `当前 pages: ${pages.map((p) => p.url).join(', ') || '(none)'}`,
  )
}

/** @deprecated 使用 evaluateInPage(..., { page: 'main' }) */
async function _pickTabtinTarget(client, vitePort = DEFAULT_VITE_PORT) {
  return pickPageTarget(client, { page: 'main', vitePort })
}

async function evaluateOnTarget(client, target, expression, { awaitPromise = true } = {}) {
  const attach = await client.send('Target.attachToTarget', {
    targetId: target.targetId,
    flatten: true,
  })
  const sessionId = attach.result?.sessionId
  if (!sessionId) throw new Error('Target.attachToTarget 未返回 sessionId')

  await client.send('Runtime.enable', {}, sessionId)
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  }, sessionId)

  if (res.result?.exceptionDetails) {
    throw new Error('evaluate 异常: ' + JSON.stringify(res.result.exceptionDetails).slice(0, 800))
  }
  return res.result?.result?.value
}

export async function withPageSession(fn, {
  page = 'main',
  port,
  vitePort = DEFAULT_VITE_PORT,
  commandTimeoutMs,
} = {}) {
  return withBrowserSession(async (client) => {
    const target = await pickPageTarget(client, { page, vitePort })
    const attach = await client.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    })
    const sessionId = attach.result?.sessionId
    if (!sessionId) throw new Error('Target.attachToTarget 未返回 sessionId')
    await client.send('Runtime.enable', {}, sessionId)
    await client.send('Page.enable', {}, sessionId)
    return fn({ client, sessionId, target })
  }, { port, commandTimeoutMs })
}

export async function evaluateInPage(expression, {
  page = 'main',
  awaitPromise = true,
  port,
  vitePort = DEFAULT_VITE_PORT,
  commandTimeoutMs,
} = {}) {
  return withBrowserSession(async (client) => {
    const target = await pickPageTarget(client, { page, vitePort })
    return evaluateOnTarget(client, target, expression, { awaitPromise })
  }, { port, commandTimeoutMs })
}

export async function evaluateInTabtinPage(expression, {
  awaitPromise = true,
  port,
  vitePort = DEFAULT_VITE_PORT,
  commandTimeoutMs,
} = {}) {
  return evaluateInPage(expression, { page: 'main', awaitPromise, port, vitePort, commandTimeoutMs })
}
