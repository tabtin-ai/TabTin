export type DistributionKind = 'official' | 'community'

export interface DistributionProfile {
  readonly kind: DistributionKind
  readonly apiOrigins: readonly string[]
  readonly updater: Readonly<{
    enabled: boolean
    feedOrigin?: string
  }>
}

export interface DistributionProfileInput {
  kind: DistributionKind
  apiBaseUrl: string
  updateFeedUrl?: string | null
}

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.internal',
])

function trustedHttpUrl(rawUrl: string, label: string): URL {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error(`blocked origin: ${label} is not a valid URL`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`blocked origin: ${label} must use HTTP(S)`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`blocked origin: ${label} must not contain credentials`)
  }
  const hostname = parsed.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`blocked origin: ${label} points to a cloud metadata host`)
  }

  return parsed
}

function uniqueOrigins(origins: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(origins)])
}

export function resolveDistributionProfile(
  input: DistributionProfileInput,
): DistributionProfile {
  const apiUrl = trustedHttpUrl(input.apiBaseUrl, 'apiBaseUrl')

  if (input.kind === 'community') {
    const feedUrl = input.updateFeedUrl
      ? trustedHttpUrl(input.updateFeedUrl, 'updateFeedUrl')
      : null
    if (feedUrl && feedUrl.protocol !== 'https:') {
      throw new Error('blocked origin: updateFeedUrl must use HTTPS')
    }
    return Object.freeze({
      kind: 'community',
      apiOrigins: uniqueOrigins([apiUrl.origin]),
      updater: Object.freeze(
        feedUrl
          ? { enabled: true, feedOrigin: feedUrl.origin }
          : { enabled: false },
      ),
    })
  }

  const feedUrl = trustedHttpUrl(
    input.updateFeedUrl || 'https://cdn.example.com/releases',
    'updateFeedUrl',
  )
  return Object.freeze({
    kind: 'official',
    apiOrigins: uniqueOrigins([
      apiUrl.origin,
      'https://www.example.com',
      'https://api-preprod.example.com',
    ]),
    updater: Object.freeze({ enabled: true, feedOrigin: feedUrl.origin }),
  })
}
