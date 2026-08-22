/**
 * 共享工具函数
 *
 * 纯函数集合，不依赖任何 crawl-view 内部模块状态。
 * 可被 cdp-browser / content-ops / ipc-handlers / 主模块安全引用。
 */

import path from 'node:path'
import fs from 'node:fs'
import type { WebContentsView, WebContents } from 'electron'
import {
  validateNavigationUrl as _validateNavigationUrl,
  isAllowedScheme,
  isPrivateHost,
  isPrivateIPv4,
  parseAlternativeIPv4,
} from '@tabtin/security-policy'
import { createLogger } from './logger'

const log = createLogger('CrawlView/utils')

export { isPrivateHost, isPrivateIPv4, parseAlternativeIPv4 }

export function getAliveWebContents(view?: WebContentsView | null): WebContents | null {
  const webContents = (view as any)?.webContents as WebContents | undefined
  if (!webContents) {
    return null
  }
  const isDestroyedFn = (webContents as any)?.isDestroyed
  try {
    if (typeof isDestroyedFn === 'function') {
      return isDestroyedFn.call(webContents) ? null : webContents
    }
  } catch (error) {
    log.warn('检查 WebContents 状态失败:', error)
    return null
  }
  return webContents
}

export function hasAliveWebContents(view?: WebContentsView | null): view is WebContentsView {
  return !!getAliveWebContents(view)
}

/**
 * : WebContents 版判活 — 与本模块 getAliveWebContents 语义等价
 * （wc 缺失 → 不存活；isDestroyed 非函数 → 视为存活；调用抛错 → warn 且不存活）。
 * 供已收窄为 WebContents 的调用面使用。
 *
 * ⚠️ 与 `webcontents/ViewStateRegistryTypes.ts` 的同名思路函数 `hasAliveWebContents`
 * 在「isDestroyed 非函数」这一边界上语义**相反**（那边视为不存活）——两模块历史上
 * 各自演化，本次零行为变化重构各自保留原语义，勿跨模块混用；收敛见 issue 跟踪。
 */
export function isAliveWebContents(webContents?: WebContents | null): webContents is WebContents {
  if (!webContents) {
    return false
  }
  const isDestroyedFn = (webContents as any)?.isDestroyed
  try {
    if (typeof isDestroyedFn === 'function') {
      return !isDestroyedFn.call(webContents)
    }
  } catch (error) {
    log.warn('检查 WebContents 状态失败:', error)
    return false
  }
  return true
}

// Electron 额外放行 about: 协议（about:blank / about:srcdoc 等）
const ELECTRON_EXTRA_PROTOCOLS = new Set(['http:', 'https:', 'about:'])

export function isAllowedUrl(url: string): boolean {
  return isAllowedScheme(url, ['about:'])
}

/**
 * 把 `file://` URL 还原成本地文件系统绝对路径；非 file 协议 / 解析失败返回 null。
 *
 * 各段做过 encodeURIComponent（见 renderer buildLocalFileUrl），这里用 URL API +
 * decodeURIComponent 还原空格 / 中文路径；Windows 去掉 pathname 前导 `/`。
 */
export function fileUrlToLocalPath(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:') return null

  let pathname: string
  try {
    pathname = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (!pathname) return null

  // Windows：`file:///C:/a` → pathname `/C:/a`，去掉前导 `/`
  if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) {
    pathname = pathname.slice(1)
  }
  return pathname
}

/**
 * 判断解析后的文件绝对路径是否落在 root 之内（含 root 自身）。
 *
 * 纯路径归一化判断（`path.resolve` 已消解 `..`），不触碰文件系统——可离线单测。
 * 门禁调用方会在此之上再叠加一层 realpath 加固（防 symlink 越界）。
 */
export function isPathWithinRoot(filePath: string, root: string): boolean {
  if (!filePath || !root) return false
  const resolvedRoot = path.resolve(root)
  const resolvedFile = path.resolve(filePath)
  if (resolvedFile === resolvedRoot) return true
  return resolvedFile.startsWith(resolvedRoot + path.sep)
}

/**
 * 受限放行判定：url 是否为「落在 root 内的本地文件」。
 *
 * 用于「Agent 产物在内嵌浏览器预览」这一可信程序化入口——view config 里带
 * `localPreviewRoot`（创建时记录的 Space 工作目录）才会走到这里。默认导航
 * （地址栏 / will-navigate / Agent loadUrl 工具）不带 root，`file://` 一律拒绝。
 *
 * 双层校验：先做纯路径归一化判断，再用 realpathSync 还原真实路径复判一次，
 * 挡掉 symlink 指向 root 外的越权（文件不存在时按归一化结果放行，交给
 * Chromium 显示标准错误页）。
 */
export function isAllowedLocalFileUrl(url: string, root: string): boolean {
  const filePath = fileUrlToLocalPath(url)
  if (!filePath || !root) return false
  if (!isPathWithinRoot(filePath, root)) return false
  try {
    const realFile = fs.realpathSync(filePath)
    const realRoot = fs.realpathSync(root)
    return isPathWithinRoot(realFile, realRoot)
  } catch {
    // 文件 / root 不存在（ENOENT 等）：归一化判断已通过，放行让 Chromium 兜底报错
    return true
  }
}

export function validateNavigationUrl(
  url: string,
  options?: {
    allowPrivateHostNavigation?: boolean
    allowedPrivateOrigins?: string[]
    /**
     * 受限放行 `file://` 的根目录（当前 Space 工作目录）。仅当 url 指向此目录内
     * 的文件时放行 file 协议；缺省则维持默认（拒绝所有 file://）。SSOT
     * （@tabtin/security-policy）不改，只在本 Electron 包装层按需把 `file:`
     * 加进 allowedProtocols。
     */
    allowLocalFileRoot?: string
  },
): { ok: boolean; error?: string } {
  const allowedProtocols = options?.allowLocalFileRoot
    && isAllowedLocalFileUrl(url, options.allowLocalFileRoot)
    ? new Set([...ELECTRON_EXTRA_PROTOCOLS, 'file:'])
    : ELECTRON_EXTRA_PROTOCOLS
  const result = _validateNavigationUrl(url, { allowedProtocols })
  if (result.ok || !options?.allowPrivateHostNavigation) return result

  try {
    const parsed = new URL(url)
    if (
      isPrivateHost(parsed.hostname)
      && !parsed.username
      && !parsed.password
      && ELECTRON_EXTRA_PROTOCOLS.has(parsed.protocol)
      && (
        !options.allowedPrivateOrigins?.length
        || options.allowedPrivateOrigins.includes(parsed.origin)
      )
    ) {
      return { ok: true }
    }
  } catch {
    // Keep the original validation error.
  }

  return result
}

export function toErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim().length > 0) {
    return error
  }
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message
  }
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim().length > 0) {
      return message
    }
    try {
      return JSON.stringify(error)
    } catch {
      // fall through
    }
  }
  return 'Unknown error'
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export const ts = (): string => new Date().toISOString()
