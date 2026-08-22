/**
 * WinRT toast 点击 → tabtin:// 协议激活（ 后续）。
 *
 * PowerShell 发出 toast 后进程即退出，无法订阅 Activated。
 * 因此在 toast XML 上挂 activationType=protocol + launch URL，
 * 由系统唤起已注册的 tabtin://，主进程再派发 notification:navigate。
 */

import type { NavigateTarget } from './types'

export const TOAST_FOCUS_HOST = 'focus'
export const TOAST_NOTIFY_HOST = 'notify'

export function resolveTabTinProtocolScheme(): string {
  switch (process.env.TABTIN_RUNTIME_PROFILE) {
    case 'preprod':
      return 'tabtin-preprod'
    case 'local':
      return 'tabtin-local'
    case 'development':
      return 'tabtin-dev'
    default:
      return 'tabtin'
  }
}

export function buildToastLaunchUrl(navigateTo?: NavigateTarget | null): string {
  const scheme = resolveTabTinProtocolScheme()
  if (!navigateTo?.type || !navigateTo.id) {
    return `${scheme}://${TOAST_FOCUS_HOST}`
  }
  const encoded = Buffer.from(JSON.stringify(navigateTo), 'utf8').toString('base64url')
  return `${scheme}://${TOAST_NOTIFY_HOST}?d=${encoded}`
}

export type ParsedToastLaunch =
  | { kind: 'notify'; navigateTo: NavigateTarget }
  | { kind: 'focus' }
  | { kind: 'other' }

export function parseToastLaunchUrl(url: string): ParsedToastLaunch {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${resolveTabTinProtocolScheme()}:`) return { kind: 'other' }

    if (parsed.hostname === TOAST_FOCUS_HOST) {
      return { kind: 'focus' }
    }

    if (parsed.hostname === TOAST_NOTIFY_HOST) {
      const raw = parsed.searchParams.get('d')
      if (!raw) return { kind: 'focus' }
      const navigateTo = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as NavigateTarget
      if (!navigateTo?.type || !navigateTo.id) {
        return { kind: 'focus' }
      }
      return { kind: 'notify', navigateTo }
    }

    return { kind: 'other' }
  } catch {
    return { kind: 'other' }
  }
}
