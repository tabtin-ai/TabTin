/**
 * reach doctor — 选路核心（纯函数）
 *
 * `doctor --json` 诊断：探"哪个后端此刻能服务这个平台"。但我们探的
 * 维度是 TabTin 自己的——运行时（Electron/Daemon）× 登录态 × 适配器可用性 × 代理。
 *
 * 这里只做**纯决策**：输入是已探测好的事实（`PlatformProbe`），输出是选路结果。
 * 真正的探测（起没起 Electron、分区里有没有 cookie）由宿主填 probe，宿主那步不纯、
 * 不在本包内。这样选路逻辑可单测、可演进，不被 Electron 绑死。
 */
import type { AuthContext, Verb } from './types'

export type Runtime = 'electron' | 'daemon'

/** 宿主探测后填入的事实。 */
export interface PlatformProbe {
  platform: string
  /** 注册表里有没有这个平台的适配器。 */
  adapterPresent: boolean
  /** 请求的动词是否被该适配器支持。 */
  supportsRequestedVerb: boolean
  /** 当前起着的浏览器运行时。 */
  runtimeAvailable: Runtime[]
  /** 目标平台域名在当前会话里是否已登录。 */
  loggedIn: boolean
  /**
   * 该动词是否需要登录态。由宿主结合 authLevel 与「该动词能否匿名跑」得出：
   * 公开检索可 false（走匿名），登录态精读 / saved / notifications 为 true。
   */
  requiresLogin: boolean
  /** 是否配了代理（部分平台海外访问必需）。 */
  proxyConfigured: boolean
  /** 撞登录墙时透传给用户的引导（来自 adapter.session.loginHint）。 */
  loginHint?: string
}

export type BackendChoice =
  | {
      status: 'ready'
      runtime: Runtime
      authContext: AuthContext
      note: string
    }
  | {
      status: 'needs-login'
      runtime: Runtime
      loginHint: string
    }
  | {
      status: 'unavailable'
      reason: string
      hint: string
    }

/** Electron 优先（人机同屏 + 复用桌面登录态），没有再退 Daemon。 */
function preferredRuntime(available: Runtime[]): Runtime | undefined {
  if (available.includes('electron')) return 'electron'
  if (available.includes('daemon')) return 'daemon'
  return undefined
}

/**
 * 依据探测事实选路。决策顺序：
 * 适配器缺 → 动词不支持 → 无运行时 → 需登录且未登录 → 就绪。
 */
export function selectBackend(probe: PlatformProbe): BackendChoice {
  if (!probe.adapterPresent) {
    return {
      status: 'unavailable',
      reason: `no adapter for "${probe.platform}"`,
      hint: '该平台尚未接入 Platform Reach；先在 packages/platform-reach 注册适配器。',
    }
  }

  if (!probe.supportsRequestedVerb) {
    return {
      status: 'unavailable',
      reason: `adapter "${probe.platform}" does not support the requested verb`,
      hint: '换用该平台支持的动词，或在适配器 verbs 里补齐这个能力。',
    }
  }

  const runtime = preferredRuntime(probe.runtimeAvailable)
  if (!runtime) {
    return {
      status: 'unavailable',
      reason: 'no browser runtime available',
      hint: '打开 TabWeb（Electron）或启动 Daemon 后重试。',
    }
  }

  if (probe.requiresLogin && !probe.loggedIn) {
    return {
      status: 'needs-login',
      runtime,
      loginHint: probe.loginHint ?? '请先在浏览器里登录目标平台，再重试。',
    }
  }

  const authContext: AuthContext = probe.loggedIn ? 'logged-in' : 'anonymous'
  const proxyNote = probe.proxyConfigured ? '，经代理' : ''
  return {
    status: 'ready',
    runtime,
    authContext,
    note: `${runtime} 运行时就绪（${authContext}${proxyNote}）`,
  }
}

/** 便于 CLI/日志展示：把选路结果压成一行人话。 */
export function describeChoice(platform: string, verb: Verb, choice: BackendChoice): string {
  switch (choice.status) {
    case 'ready':
      return `[reach:${platform}] ${verb} → ${choice.note}`
    case 'needs-login':
      return `[reach:${platform}] ${verb} → 需登录（${choice.runtime}）：${choice.loginHint}`
    case 'unavailable':
      return `[reach:${platform}] ${verb} → 不可用：${choice.reason}。${choice.hint}`
  }
}
