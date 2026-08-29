/**
 * Access Barrier 超时 / 仍停在登录墙时的 open 复用抑制。
 *
 * 同 run 默认会 reuse 已开 tab，避免堆标签；但 HITL 超时后旧 tab 往往仍停在
 * signin，再 reuse 会二次弹卡且观察粘死旧文档。超时决议记下 tabId；open 复用
 * 前若命中该 tab（或 URL 仍像登录墙）则跳过复用、开新 tab。
 */

const timedOutTabIds = new Set<string>()

/** HITL 返回 timeout 时登记，供同 run 下一次 open 跳过复用。 */
export function markAccessBarrierTabTimedOut(tabId: string | undefined | null): void {
  if (!tabId || typeof tabId !== 'string') return
  const id = tabId.trim()
  if (!id) return
  timedOutTabIds.add(id)
}

/** 是否曾因 Access Barrier 超时登记（消费后清除，只挡一次重试）。 */
export function consumeAccessBarrierTabTimedOut(tabId: string): boolean {
  if (!timedOutTabIds.has(tabId)) return false
  timedOutTabIds.delete(tabId)
  return true
}

export function __resetAccessBarrierTabTimedOutForTest(): void {
  timedOutTabIds.clear()
}

/** URL 是否仍像登录 / 授权 / 验证码墙（启发式，配合超时登记双保险）。 */
export function looksLikeAuthWallUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false
  try {
    const parsed = new URL(url)
    const haystack = `${parsed.hostname}${parsed.pathname}${parsed.search}`.toLowerCase()
    return /(?:^|[./_-])(signin|sign_in|sign-in|login|log-in|passport|sso|oauth|captcha|accounts\.google|auth\/|\/auth$)(?:[./?#_-]|$)/.test(
      haystack,
    ) || /[?&](login|signin)=/.test(haystack)
  } catch {
    return /signin|login|passport|captcha/i.test(url)
  }
}
