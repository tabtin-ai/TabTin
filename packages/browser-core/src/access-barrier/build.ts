/**
 * 从 observe/act 引擎原始产出构造 `AccessBarrier`（设计 §5.1 / §5.3）。
 *
 * 复用现有 `auth_wall` / `captcha.detected` 判定条件（与
 * `BrowserOrchestrator.ts` 的 `buildLoginRequired` / `buildCaptchaRequired` 同源信号），
 * 不重新发明探测逻辑——这里只做「信号 → 归一 AccessBarrier」的一次性收敛。
 */
import type { AccessBarrier, AccessBarrierActionId, AccessBarrierKind } from './types.js'

/** 按 kind 给默认动作集（设计 §5.3）；`mfa` 不含「换源冒充」。 */
export function defaultActionsForKind(kind: AccessBarrierKind): AccessBarrierActionId[] {
  if (kind === 'mfa') return ['resume_same_tab', 'abort_this_target']
  return ['resume_same_tab', 'alternate_source', 'abort_this_target']
}

/**
 * 从 URL 解析 hostname；解析失败（非法 URL / 缺协议）返回 `'unknown'`。
 * 去掉前导 `www.`——卡片文案与「同域重复」判定（设计 §7.4）按裸域比较，
 * `www.xiaohongshu.com` 与 `xiaohongshu.com` 应视为同一站点。
 */
function resolveDomain(pageUrl: string | undefined): string {
  if (!pageUrl) return 'unknown'
  try {
    const hostname = new URL(pageUrl).hostname
    if (!hostname) return 'unknown'
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname
  } catch {
    return 'unknown'
  }
}

/** `captcha.type` 含 `geetest` → 独立 kind；否则通用 `captcha`（设计 §5.1 注）。 */
function captchaKindFromType(type: string | undefined): AccessBarrierKind {
  return typeof type === 'string' && type.toLowerCase().includes('geetest') ? 'geetest' : 'captcha'
}

export interface BuildAccessBarrierContext {
  pageUrl?: string
  tabId?: string
  sourceTool?: string
}

/**
 * 从 observe/act raw 构造 `AccessBarrier`；无墙信号返回 `null`。
 *
 * 命中优先级：`block.type==='auth_wall' || block.loginRequired`（登录墙）优先于
 * `captcha.detected`（人机校验）——与 `projectObservePayload` 墙信号置顶顺序一致。
 */
export function buildAccessBarrierFromObserveRaw(
  raw: Record<string, any> | null | undefined,
  ctx: BuildAccessBarrierContext,
): AccessBarrier | null {
  const block = raw?.block
  const captcha = raw?.captcha

  const isAuthWall = !!block && (block.type === 'auth_wall' || block.loginRequired === true)
  const isCaptcha = !!captcha && captcha.detected === true

  if (!isAuthWall && !isCaptcha) return null

  const pageUrl = ctx.pageUrl
    ?? (typeof raw?.page_url === 'string' ? raw.page_url : undefined)
    ?? (typeof captcha?.page_url === 'string' ? captcha.page_url : undefined)

  const kind: AccessBarrierKind = isAuthWall ? 'login' : captchaKindFromType(captcha?.type)

  const reason = isAuthWall
    ? (typeof block?.reason === 'string' && block.reason ? block.reason : '页面需要登录')
    : (typeof captcha?.type === 'string' && captcha.type
        ? `页面需要完成验证码（${captcha.type}）`
        : '页面需要完成验证码')

  return {
    kind,
    reason,
    domain: resolveDomain(pageUrl),
    pageUrl,
    tabId: ctx.tabId,
    captchaType: isCaptcha ? captcha?.type : undefined,
    sourceTool: ctx.sourceTool,
    detectedAt: new Date().toISOString(),
    actions: defaultActionsForKind(kind),
  }
}
