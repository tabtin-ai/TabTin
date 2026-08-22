import { readFileSync } from 'node:fs'
import { resolveDistributionProfile, type DistributionKind } from './distribution-profile'

export const LEGACY_DEFAULT_FEED_URL = 'https://cdn.example.com/releases/'

type EnvLike = Record<string, string | undefined>
export type UpdateChannel = 'stable' | 'beta' | 'alpha'

type GenericPublishOption = {
  provider?: string
  url?: string
}

type ResolveDefaultFeedUrlOptions = {
  updateServerUrl?: string
  env?: EnvLike
  packageJsonPath?: string
  fallbackUrl?: string
}

type ResolveUpdateChannelOptions = {
  env?: EnvLike
  packageJsonPath?: string
  fallbackChannel?: UpdateChannel
}

type PackagedDistributionMetadata = {
  kind: DistributionKind
  apiBaseUrl: string
  updateFeedUrl?: string
}

type ResolvePackagedUpdaterConfigOptions = ResolveDefaultFeedUrlOptions & {
  apiBaseUrl?: string
}

export type PackagedUpdaterConfig =
  | { enabled: false }
  | { enabled: true; feedUrl: string; feedOrigin: string }

export function normalizeFeedUrl(url?: string | null): string | null {
  const trimmed = url?.trim()
  if (!trimmed) return null
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`
}

export function normalizeUpdateChannel(channel?: string | null): UpdateChannel | null {
  const normalized = channel?.trim().toLowerCase()
  if (normalized === 'stable' || normalized === 'beta' || normalized === 'alpha') {
    return normalized
  }
  return null
}

function isGenericPublishOption(value: unknown): value is GenericPublishOption {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'provider' in value &&
    (value as Record<string, unknown>).provider === 'generic'
  )
}

export function extractGenericPublishUrl(publishConfig: unknown): string | null {
  if (!publishConfig) {
    return null
  }

  if (Array.isArray(publishConfig)) {
    for (const entry of publishConfig) {
      const url = extractGenericPublishUrl(entry)
      if (url) {
        return url
      }
    }
    return null
  }

  if (isGenericPublishOption(publishConfig)) {
    return normalizeFeedUrl(publishConfig.url)
  }

  return null
}

export function loadPackagedPublishFeedUrl(packageJsonPath?: string): string | null {
  if (!packageJsonPath) {
    return null
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    return extractGenericPublishUrl(packageJson?.build?.publish)
  } catch {
    return null
  }
}

export function loadPackagedUpdateChannel(packageJsonPath?: string): UpdateChannel | null {
  if (!packageJsonPath) {
    return null
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    return normalizeUpdateChannel(packageJson?.tabtinDesktop?.updateChannel)
  } catch {
    return null
  }
}

export function loadPackagedDistributionMetadata(
  packageJsonPath?: string,
): PackagedDistributionMetadata | null {
  if (!packageJsonPath) return null

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
    const distribution = packageJson?.tabtinDesktop?.distribution
    if (!distribution || (distribution.kind !== 'official' && distribution.kind !== 'community')) {
      return null
    }
    if (typeof distribution.apiBaseUrl !== 'string' || !distribution.apiBaseUrl.trim()) {
      return null
    }
    return {
      kind: distribution.kind,
      apiBaseUrl: distribution.apiBaseUrl,
      ...(typeof distribution.updateFeedUrl === 'string'
        ? { updateFeedUrl: distribution.updateFeedUrl }
        : {}),
    }
  } catch {
    return null
  }
}

export function resolveUpdateChannel(options: ResolveUpdateChannelOptions = {}): UpdateChannel {
  const env = options.env ?? process.env

  return (
    loadPackagedUpdateChannel(options.packageJsonPath) ??
    normalizeUpdateChannel(env.TABTIN_UPDATE_CHANNEL) ??
    normalizeUpdateChannel(env.UPDATE_CHANNEL) ??
    options.fallbackChannel ??
    'stable'
  )
}

export function resolveDefaultFeedUrl(options: ResolveDefaultFeedUrlOptions = {}): string {
  const env = options.env ?? process.env

  const explicitFeedUrl =
    normalizeFeedUrl(options.updateServerUrl) ??
    normalizeFeedUrl(env.TABTIN_UPDATE_FEED_URL) ??
    normalizeFeedUrl(env.UPDATE_SERVER_URL)

  if (explicitFeedUrl) {
    return explicitFeedUrl
  }

  return (
    loadPackagedPublishFeedUrl(options.packageJsonPath) ??
    normalizeFeedUrl(options.fallbackUrl) ??
    LEGACY_DEFAULT_FEED_URL
  )
}

export function resolvePackagedUpdaterConfig(
  options: ResolvePackagedUpdaterConfigOptions = {},
): PackagedUpdaterConfig {
  const metadata = loadPackagedDistributionMetadata(options.packageJsonPath)

  if (metadata?.kind === 'community') {
    let profile: ReturnType<typeof resolveDistributionProfile>
    try {
      profile = resolveDistributionProfile(metadata)
    } catch {
      return { enabled: false }
    }
    if (!profile.updater.enabled || !metadata.updateFeedUrl || !profile.updater.feedOrigin) {
      return { enabled: false }
    }
    return {
      enabled: true,
      feedUrl: normalizeFeedUrl(metadata.updateFeedUrl) as string,
      feedOrigin: profile.updater.feedOrigin,
    }
  }

  const feedUrl = resolveDefaultFeedUrl(options)
  return {
    enabled: true,
    feedUrl,
    feedOrigin: new URL(feedUrl).origin,
  }
}
