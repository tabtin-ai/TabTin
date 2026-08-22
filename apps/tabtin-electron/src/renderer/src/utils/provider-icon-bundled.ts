/**
 * Electron 内置 Provider 品牌标（构建时从 Django static 镜像）。
 * 优先于 API 拉取：离线、lite 模式、后端未起时也能显示。
 */

const bundledProviderIcons = import.meta.glob<string>(
  '@/assets/provider-icons/*.svg',
  { eager: true, query: '?url', import: 'default' },
)

function stemFromGlobPath(path: string): string {
  const matched = path.match(/\/([^/]+)\.svg$/)
  return matched?.[1]?.toLowerCase() ?? ''
}

const bundledByKey = new Map<string, string>()
for (const [path, url] of Object.entries(bundledProviderIcons)) {
  const key = stemFromGlobPath(path)
  if (key && url) bundledByKey.set(key, url)
}

/** 返回 Vite 打包后的本地 URL；无内置资源时返回空串。 */
export function getBundledProviderIconUrl(iconKey: string): string {
  const key = iconKey.trim().toLowerCase()
  return key ? (bundledByKey.get(key) ?? '') : ''
}

export function hasBundledProviderIcon(iconKey: string): boolean {
  return bundledByKey.has(iconKey.trim().toLowerCase())
}
