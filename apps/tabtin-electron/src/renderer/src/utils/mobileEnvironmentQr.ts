export const MOBILE_ENVIRONMENT_QR_SCHEME = 'tabtin:'
export const MOBILE_ENVIRONMENT_QR_HOST = 'mobile-environment'
export const MOBILE_ENVIRONMENT_QR_VERSION = '1'

export interface MobileEnvironmentQrConfig {
  apiUrl: string
  websocketUrl: string
  webUrl: string
  centrifugoUrl: string
}

const normalizeUrl = (value: string): string => value.trim().replace(/\/+$/, '')
const loopbackHosts = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])

const isLoopbackUrl = (value: string): boolean => {
  try {
    return loopbackHosts.has(new URL(value).hostname.toLowerCase())
  } catch {
    return false
  }
}

const replaceApiPath = (
  rawApiUrl: string,
  pathname: string,
  protocol?: 'ws:' | 'wss:',
): string => {
  const url = new URL(normalizeUrl(rawApiUrl))
  const basePath = url.pathname.replace(/\/api\/?$/, '').replace(/\/+$/, '')
  url.pathname = `${basePath}${pathname}`
  url.search = ''
  url.hash = ''
  if (protocol) url.protocol = protocol
  return url.toString().replace(/\/$/, '')
}

export function deriveMobileWebsocketUrl(apiUrl: string): string {
  const api = new URL(normalizeUrl(apiUrl))
  return replaceApiPath(
    api.toString(),
    '/ws/v1/gateway',
    api.protocol === 'https:' ? 'wss:' : 'ws:',
  )
}

export function deriveMobileWebUrl(apiUrl: string): string {
  return replaceApiPath(apiUrl, '')
}

export function deriveMobileCentrifugoUrl(apiUrl: string): string {
  const api = new URL(normalizeUrl(apiUrl))
  const centrifugo = new URL(
    replaceApiPath(
      api.toString(),
      '/connection/websocket',
      api.protocol === 'https:' ? 'wss:' : 'ws:',
    ),
  )
  if (api.port === '6060') centrifugo.port = '8100'
  return normalizeUrl(centrifugo.toString())
}

export function buildMobileEnvironmentQrValue(
  config: MobileEnvironmentQrConfig,
): string {
  const payload = new URL(
    `${MOBILE_ENVIRONMENT_QR_SCHEME}//${MOBILE_ENVIRONMENT_QR_HOST}`,
  )
  payload.searchParams.set('v', MOBILE_ENVIRONMENT_QR_VERSION)
  payload.searchParams.set('api', normalizeUrl(config.apiUrl))
  payload.searchParams.set('ws', normalizeUrl(config.websocketUrl))
  payload.searchParams.set('web', normalizeUrl(config.webUrl))
  payload.searchParams.set('centrifugo', normalizeUrl(config.centrifugoUrl))
  return payload.toString()
}

export function isLoopbackMobileEnvironment(
  config: MobileEnvironmentQrConfig,
): boolean {
  return Object.values(config).some(isLoopbackUrl)
}

export function replaceLoopbackHosts(
  config: MobileEnvironmentQrConfig,
  address: string,
): MobileEnvironmentQrConfig {
  const replace = (value: string): string => {
    if (!isLoopbackUrl(value)) return value
    const url = new URL(value)
    url.hostname = address
    return normalizeUrl(url.toString())
  }

  return {
    apiUrl: replace(config.apiUrl),
    websocketUrl: replace(config.websocketUrl),
    webUrl: replace(config.webUrl),
    centrifugoUrl: replace(config.centrifugoUrl),
  }
}
