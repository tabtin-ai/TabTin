import { parse } from 'tldts'

export interface RelayCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  expirationDate?: number
}

export function normalizeRelayDomain(domain: string): string | null {
  if (typeof domain !== 'string' || !domain || domain !== domain.trim()) return null
  const host = domain.startsWith('.') ? domain.slice(1) : domain
  if (
    !host
    || host.startsWith('.')
    || host.endsWith('.')
    || /[\s/@\\]/.test(host)
    || host.includes('..')
    || (host.includes(':') && !(host.startsWith('[') && host.endsWith(']')))
  ) {
    return null
  }

  try {
    const parsed = new URL(`https://${host}/`)
    if (
      parsed.username
      || parsed.password
      || parsed.port
      || parsed.pathname !== '/'
    ) {
      return null
    }
    return parsed.hostname.toLowerCase()
  } catch {
    return null
  }
}

function isRegistrableDnsDomain(host: string): boolean {
  const result = parse(host, { allowPrivateDomains: true })
  return result.isIp === false
    && result.domain !== null
    && (result.isIcann === true || result.isPrivate === true)
}

/**
 * Start IPC 专用的目标域校验。Cookie 自身仍可合法来自 localhost / IP，
 * 但登录接力窗口只允许可注册的公网 DNS 域，避免把受信任窗口变成内网访问入口。
 */
export function normalizeRelayTargetDomain(domain: string): string | null {
  const host = normalizeRelayDomain(domain)
  if (!host || domain.startsWith('.') || !isRegistrableDnsDomain(host)) return null
  return host
}

/** 判断两个安全 DNS host 是否属于同一个可注册站点。 */
export function sharesRelaySite(firstDomain: string, secondDomain: string): boolean {
  const first = normalizeRelayTargetDomain(firstDomain)
  const second = normalizeRelayTargetDomain(secondDomain)
  if (!first || !second) return false
  const firstParsed = parse(first, { allowPrivateDomains: true })
  const secondParsed = parse(second, { allowPrivateDomains: true })
  return firstParsed.domain !== null && firstParsed.domain === secondParsed.domain
}

export function matchesRelayDomain(cookieDomain: string, wallDomain: string): boolean {
  const cookieHost = normalizeRelayDomain(cookieDomain)
  const wallHost = normalizeRelayDomain(wallDomain)
  if (!cookieHost || !wallHost) return false
  const isDomainCookie = cookieDomain.startsWith('.')
  const ordinaryCookieDomain = isRegistrableDnsDomain(cookieHost)
  const ordinaryWallDomain = isRegistrableDnsDomain(wallHost)
  if (!ordinaryCookieDomain || !ordinaryWallDomain) {
    return !isDomainCookie && cookieHost === wallHost
  }
  if (isDomainCookie && !ordinaryCookieDomain) return false
  return cookieHost === wallHost
    || cookieHost.endsWith(`.${wallHost}`)
    || wallHost.endsWith(`.${cookieHost}`)
}

function normalizeSameSite(value: string | undefined): Electron.Cookie['sameSite'] | null {
  if (value === undefined || value === '' || value.toLowerCase() === 'unspecified') return 'lax'
  switch (value.toLowerCase()) {
    case 'none':
    case 'no_restriction':
      return 'no_restriction'
    case 'strict':
      return 'strict'
    case 'lax':
      return 'lax'
    default:
      return null
  }
}

function isSafeCookieText(value: unknown): value is string {
  return typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value)
}

export function toCookiesSetDetails(
  cookie: RelayCookie,
  nowSeconds = Date.now() / 1_000,
): Electron.CookiesSetDetails | null {
  if (
    !cookie
    || !isSafeCookieText(cookie.name)
    || !cookie.name
    || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(cookie.name)
    || !isSafeCookieText(cookie.value)
    || !/^[\u0021\u0023-\u002b\u002d-\u003a\u003c-\u005b\u005d-\u007e]*$/.test(cookie.value)
    || !isSafeCookieText(cookie.path)
    || !cookie.path.startsWith('/')
    || typeof cookie.secure !== 'boolean'
    || typeof cookie.httpOnly !== 'boolean'
  ) {
    return null
  }

  const host = normalizeRelayDomain(cookie.domain)
  const sameSite = normalizeSameSite(cookie.sameSite)
  if (!host || !sameSite) return null
  if (cookie.domain.startsWith('.') && !isRegistrableDnsDomain(host)) return null
  if (
    cookie.expirationDate !== undefined
    && (
      typeof cookie.expirationDate !== 'number'
      || !Number.isFinite(cookie.expirationDate)
    )
  ) {
    return null
  }
  if (cookie.expirationDate !== undefined && cookie.expirationDate <= nowSeconds) return null
  if (sameSite === 'no_restriction' && !cookie.secure) return null

  const cookieUrl = new URL(`${cookie.secure ? 'https' : 'http'}://${host}/`)
  cookieUrl.pathname = cookie.path
  const details: Electron.CookiesSetDetails = {
    url: cookieUrl.toString(),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
  }
  if (cookie.domain.startsWith('.')) details.domain = `.${host}`
  if (cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate
  return details
}

export function toRelayCookies(
  cookies: Electron.Cookie[],
  wallDomain: string,
  nowSeconds = Date.now() / 1_000,
): RelayCookie[] {
  const result: RelayCookie[] = []
  for (const cookie of cookies) {
    if (!cookie.domain || !matchesRelayDomain(cookie.domain, wallDomain)) continue
    const relayCookie: RelayCookie = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path ?? '/',
      secure: cookie.secure ?? false,
      httpOnly: cookie.httpOnly ?? false,
      sameSite: cookie.sameSite,
      ...(typeof cookie.expirationDate === 'number'
        ? { expirationDate: cookie.expirationDate }
        : {}),
    }
    if (toCookiesSetDetails(relayCookie, nowSeconds)) result.push(relayCookie)
  }
  return result
}
