export type AppIconPresentation = 'selfContained' | 'glyph'

/**
 * App manifest 的图标资产契约。
 *
 * `default` / `variants` 都是相对当前 App 包的资源路径；后端只透传描述，
 * Electron 在构建期把包内 SVG 编译为可离线使用的 URL。
 */
export interface AppIconAssetDescriptor {
  default: string
  variants?: Record<string, string>
  presentation: AppIconPresentation
  aliases?: string[]
}
