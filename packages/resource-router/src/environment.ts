import type { TabTinResourceScheme } from './types.js'

export interface TabTinResourceEnvironment {
  apiBaseUrl: string
  buildProfile: string
}

function isPrivateIPv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false
  const parts = hostname.split('.').map(Number)
  if (parts.some((part) => part < 0 || part > 255)) return false
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 127
  )
}

/** Resolve the resource protocol from the actual data source, then fall back to build identity. */
export function resolveTabTinResourceScheme(
  environment: TabTinResourceEnvironment,
): TabTinResourceScheme {
  try {
    const hostname = new URL(environment.apiBaseUrl).hostname.toLowerCase()
    if (hostname === 'api.example.com') return 'tabtin'
    if (hostname === 'api-test.example.com') return 'tabtin-preprod'
    if (
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname === 'host.docker.internal' ||
      isPrivateIPv4(hostname)
    ) {
      return 'tabtin-dev'
    }
  } catch {
    // Invalid or relative custom API values fall back to the build identity below.
  }

  if (environment.buildProfile === 'preprod') return 'tabtin-preprod'
  if (
    environment.buildProfile === 'development' ||
    environment.buildProfile === 'local'
  ) {
    return 'tabtin-dev'
  }
  return 'tabtin'
}
