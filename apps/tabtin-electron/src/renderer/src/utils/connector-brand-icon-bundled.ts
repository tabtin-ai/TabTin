/**
 * Electron 本地镜像的连接器品牌 SVG。
 * 资产与匹配规则的 SSoT 在 `@tabtin/connector-brand-icons`；此处只做 Vite URL 解析。
 */

const bundledConnectorBrandIcons = import.meta.glob<string>(
  '../../../../../../packages/connector-brand-icons/icons/*.svg',
  { eager: true, query: '?url', import: 'default' },
)

function stemFromGlobPath(path: string): string {
  const matched = path.match(/\/([^/]+)\.svg$/)
  return matched?.[1]?.toLowerCase() ?? ''
}

const bundledByKey = new Map<string, string>()
for (const [path, url] of Object.entries(bundledConnectorBrandIcons)) {
  const key = stemFromGlobPath(path)
  if (key && url) bundledByKey.set(key, url)
}

export function getBundledConnectorBrandIconUrl(brandKey: string): string {
  const key = brandKey.trim().toLowerCase()
  return key ? (bundledByKey.get(key) ?? '') : ''
}
