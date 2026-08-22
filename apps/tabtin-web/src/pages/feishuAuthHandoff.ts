/**
 * Electron → tabtin-web 一次性登录交接（与 SharedHtmlPage 同口径）。
 * hash 携带 access token；读完立刻 strip，避免地址栏泄露。
 */
import { STORAGE_KEYS } from '@/platform'

const TABTIN_WEB_AUTH_HANDOFF_PREFIX = 'tabtin_handoff='

export function consumeTabtinWebAuthHandoff(): boolean {
  if (typeof window === 'undefined') return false
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!rawHash.startsWith(TABTIN_WEB_AUTH_HANDOFF_PREFIX)) return false
  const token = decodeURIComponent(rawHash.slice(TABTIN_WEB_AUTH_HANDOFF_PREFIX.length)).trim()
  const cleanUrl = `${window.location.pathname}${window.location.search}`
  window.history.replaceState(null, '', cleanUrl)
  if (!token) return false
  localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token)
  return true
}
