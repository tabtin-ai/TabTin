import type {
  AppIconAssetDescriptor,
  AppIconPresentation,
} from '@/types/appIcon'

export type AppIconUsage = 'entry' | 'tab'

interface RawAppManifest {
  id?: unknown
  uiHints?: {
    iconAsset?: unknown
  }
  agentIntegration?: {
    typeAliases?: unknown
  }
}

interface RawShellIconManifest {
  icons?: Record<string, unknown>
}

interface ResolvedIconAsset {
  descriptor: AppIconAssetDescriptor
  urls: Record<string, string>
}

const appManifests = import.meta.glob<RawAppManifest>(
  '../../../../../../../packages/apps/*/app.json',
  { eager: true, import: 'default' },
)

const appSvgAssets = import.meta.glob<string>(
  '../../../../../../../packages/apps/*/assets/*.svg',
  { eager: true, query: '?url', import: 'default' },
)

const shellIconManifests = import.meta.glob<RawShellIconManifest>(
  '../../../../../../../packages/app-shell/app-icons.json',
  { eager: true, import: 'default' },
)

const shellSvgAssets = import.meta.glob<string>(
  '../../../../../../../packages/app-shell/assets/app-icons/*.svg',
  { eager: true, query: '?url', import: 'default' },
)

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}

function normalizeRelativeSvgPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || path.split('/').includes('..')
    || !path.toLowerCase().endsWith('.svg')
  ) {
    return null
  }
  return path
}

function normalizeIconAsset(value: unknown): AppIconAssetDescriptor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const raw = value as Record<string, unknown>
  const defaultPath = normalizeRelativeSvgPath(raw.default)
  if (!defaultPath) return null

  const variants: Record<string, string> = {}
  if (raw.variants && typeof raw.variants === 'object' && !Array.isArray(raw.variants)) {
    for (const [variant, pathValue] of Object.entries(raw.variants)) {
      const path = normalizeRelativeSvgPath(pathValue)
      if (variant && path) variants[variant] = path
    }
  }

  const aliases = Array.isArray(raw.aliases)
    ? raw.aliases
        .filter((alias): alias is string => typeof alias === 'string')
        .map(normalizeKey)
        .filter(Boolean)
    : []

  return {
    default: defaultPath,
    ...(Object.keys(variants).length > 0 ? { variants } : {}),
    presentation: raw.presentation === 'glyph' ? 'glyph' : 'selfContained',
    ...(aliases.length > 0 ? { aliases: [...new Set(aliases)] } : {}),
  }
}

function resolveAsset(
  manifestPath: string,
  relativePath: string,
  assets: Record<string, string>,
): string | null {
  const manifestDirectory = manifestPath.slice(0, manifestPath.lastIndexOf('/'))
  return assets[`${manifestDirectory}/${relativePath}`] ?? null
}

function buildResolvedAsset(
  manifestPath: string,
  descriptor: AppIconAssetDescriptor,
  assets: Record<string, string>,
): ResolvedIconAsset | null {
  const urls: Record<string, string> = {}
  const defaultUrl = resolveAsset(manifestPath, descriptor.default, assets)
  if (!defaultUrl) return null
  urls.default = defaultUrl

  for (const [variant, relativePath] of Object.entries(descriptor.variants ?? {})) {
    const url = resolveAsset(manifestPath, relativePath, assets)
    if (url) urls[variant] = url
  }

  return { descriptor, urls }
}

const iconAssetsByKey = new Map<string, ResolvedIconAsset>()

for (const [manifestPath, manifest] of Object.entries(appManifests)) {
  const appId = typeof manifest.id === 'string' ? normalizeKey(manifest.id) : ''
  const descriptor = normalizeIconAsset(manifest.uiHints?.iconAsset)
  if (!appId || !descriptor) continue

  const resolved = buildResolvedAsset(manifestPath, descriptor, appSvgAssets)
  if (!resolved) continue

  const integrationAliases = Array.isArray(manifest.agentIntegration?.typeAliases)
    ? manifest.agentIntegration.typeAliases.filter(
        (alias): alias is string => typeof alias === 'string',
      )
    : []

  for (const key of [
    appId,
    ...(descriptor.aliases ?? []),
    ...integrationAliases,
  ]) {
    const normalizedKey = normalizeKey(key)
    if (normalizedKey) iconAssetsByKey.set(normalizedKey, resolved)
  }
}

for (const [manifestPath, manifest] of Object.entries(shellIconManifests)) {
  for (const [iconId, rawDescriptor] of Object.entries(manifest.icons ?? {})) {
    const descriptor = normalizeIconAsset(rawDescriptor)
    if (!descriptor) continue

    const resolved = buildResolvedAsset(manifestPath, descriptor, shellSvgAssets)
    if (!resolved) continue

    for (const key of [iconId, ...(descriptor.aliases ?? [])]) {
      const normalizedKey = normalizeKey(key)
      if (normalizedKey) iconAssetsByKey.set(normalizedKey, resolved)
    }
  }
}

export function resolveAppIconUrl(
  appIdOrType: string,
  usage: AppIconUsage = 'entry',
): string | null {
  const asset = iconAssetsByKey.get(normalizeKey(appIdOrType))
  if (!asset) return null
  return asset.urls[usage] ?? asset.urls.default ?? null
}

export function resolveAppIconPresentation(
  appIdOrType: string,
): AppIconPresentation | null {
  return iconAssetsByKey.get(normalizeKey(appIdOrType))?.descriptor.presentation ?? null
}
