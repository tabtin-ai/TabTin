import { buildPublicInviteBridgeUrl } from '@tabtin/config'

import { API_BASE_URL } from '@/api/client'
import type { OrganizationInvitationItem } from '@/types/space-admin'

/**
 * 把当前访问/API 域名映射到公开邀请页（tabtin-web）域名。
 * 规则：admin-test / api-test → web-test；admin / api → web；本地 → 127.0.0.1:5176。
 *
 * 优先级：页面域名（非本地）→ API 域名 → 显式 env → 本地默认。
 */
export function resolvePublicInviteWebBase(options?: {
  pageHostname?: string
  apiBaseUrl?: string
  explicitBase?: string
}): string | undefined {
  const pageHostname =
    options?.pageHostname ??
    (typeof window !== 'undefined' ? window.location.hostname : '')

  if (pageHostname && !isLocalHostname(pageHostname)) {
    const fromPage = publicWebBaseFromHostname(pageHostname)
    if (fromPage) return fromPage
  }

  const apiBaseUrl = options?.apiBaseUrl ?? API_BASE_URL
  const fromApi = publicWebBaseFromHostname(hostnameFromUrl(apiBaseUrl))
  if (fromApi && !isLocalHostname(hostnameFromUrl(apiBaseUrl))) return fromApi

  const explicit = (options?.explicitBase || '').trim().replace(/\/+$/, '')
  if (explicit) return explicit

  return publicWebBaseFromHostname(pageHostname) || fromApi
}

export function publicWebBaseFromHostname(hostname: string | undefined): string | undefined {
  const host = (hostname || '').trim().toLowerCase()
  if (!host) return undefined

  if (isLocalHostname(host)) {
    return 'http://127.0.0.1:5176'
  }

  // admin-test.example.com / api-test.example.com → https://web-test.example.com
  // admin.example.com / api.example.com → https://web.example.com
  const sibling = host.match(/^(?:admin|api|web)(-[a-z0-9]+)?\.tabtin\.com$/)
  if (sibling) {
    return `https://web${sibling[1] || ''}.example.com`
  }

  return undefined
}

/**
 * 组织邀请可分享链接 = 当前环境公开域名 + /invite/ + token。
 */
export function resolveInvitationLink(
  invitation: Pick<OrganizationInvitationItem, 'invite_type' | 'invite_url' | 'token'>,
  publicWebBaseUrl?: string,
): string {
  if (invitation.invite_type === 'link' && invitation.token) {
    const base = resolvePublicInviteWebBase({
      explicitBase: publicWebBaseUrl ?? import.meta.env.VITE_PUBLIC_WEB_BASE_URL,
    })
    if (base) {
      try {
        const built = buildPublicInviteBridgeUrl(base, invitation.token)
        if (built) return built
      } catch {
        // fall through to invite_url
      }
    }
  }

  const fromApi = (invitation.invite_url || '').trim()
  if (fromApi) return fromApi
  return ''
}

export function invitationTargetLabel(
  invitation: Pick<
    OrganizationInvitationItem,
    'invite_type' | 'invite_url' | 'token' | 'invited_user_id' | 'email'
  >,
  publicWebBaseUrl?: string,
): string {
  if (invitation.invite_type === 'link') {
    return resolveInvitationLink(invitation, publicWebBaseUrl) || invitation.token || '—'
  }
  return invitation.invited_user_id || invitation.email || invitation.token || '—'
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]'
  )
}

function hostnameFromUrl(value: string | undefined): string {
  const raw = (value || '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}
