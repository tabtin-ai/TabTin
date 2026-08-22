import { createRequire } from 'node:module'

const requireRipgrep = createRequire(import.meta.url)

let cachedBundledRgPath: string | null | undefined

/**
 * 懒加载 @vscode/ripgrep 的平台二进制路径。
 *
 * FileSystemIPC 里多数 handler（ensureDefaultAgentDir / ensureSpaceSandbox 等）
 * 不依赖 rg；若顶层 import '@vscode/ripgrep'，Intel 打包缺 darwin-x64 可选包时
 * 整模块加载失败。仅在 ripgrep 搜索真正执行时才解析。
 */
export function getBundledRipgrepPath(): string | null {
  if (cachedBundledRgPath !== undefined) return cachedBundledRgPath
  try {
    const { rgPath } = requireRipgrep('@vscode/ripgrep') as { rgPath: string }
    cachedBundledRgPath = rgPath
  } catch {
    cachedBundledRgPath = null
  }
  return cachedBundledRgPath
}
