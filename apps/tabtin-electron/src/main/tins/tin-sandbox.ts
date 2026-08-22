/**
 * TinSandbox - Tin HTML 面板的沙箱化渲染
 *
 * 使用 Electron 的 <webview> tag 在渲染进程中加载 Tin 面板，
 * 通过 preload 脚本注入 window.tin API，实现安全隔离。
 *
 * 安全策略：
 * - nodeIntegration: false（Tin 代码不能访问 Node.js）
 * - contextIsolation: true（window.tin 通过 preload 注入）
 * - sandbox: true（OS 级沙箱隔离）
 * - 仅允许 CDN 资源加载（通过 CSP）
 */

import { app, session } from 'electron'
import { join } from 'path'
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync } from 'fs'
import { stat, readdir } from 'fs/promises'
import { randomBytes, createHash } from 'crypto'
import { registerStorageBucket } from '@tabtin/storage-manager'
import { logger } from '../utils/logger'
import { generateTinPreloadScript } from './tin-bridge'
import { UUID_RE } from './types'

const TAG = 'TinSandbox'

const TIN_SANDBOX_DIR = join(app.getPath('userData'), 'tin-sandboxes')

export interface SandboxConfig {
  instanceId: string
  panelHtml: string
  variables: Record<string, unknown>
  pageContext: {
    url: string
    title: string
    language?: string
  }
}

/**
 * 安全写入沙箱文件：owner-only 权限 (0o600) + 写后完整性校验。
 * 防止 userData 目录被恶意程序篡改后注入代码到 Tin 沙箱 preload。
 */
function writeSecureFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o600 })
  try { chmodSync(filePath, 0o600) } catch { /* best-effort on existing files */ }

  const written = readFileSync(filePath, 'utf-8')
  const expectedHash = createHash('sha256').update(content).digest('hex')
  const actualHash = createHash('sha256').update(written).digest('hex')
  if (expectedHash !== actualHash) {
    rmSync(filePath, { force: true })
    throw new Error(`Sandbox file integrity check failed: ${filePath}`)
  }
}

/**
 * 为 Tin 实例准备沙箱文件（HTML + preload 脚本）。
 *
 * 返回值包含 htmlPath 和 preloadPath，
 * 由渲染进程的 <webview> 组件使用。
 */
export function prepareSandbox(config: SandboxConfig): {
  htmlPath: string
  preloadPath: string
} {
  if (!UUID_RE.test(config.instanceId)) {
    throw new Error(`Invalid instanceId for sandbox: ${config.instanceId}`)
  }
  const sandboxDir = join(TIN_SANDBOX_DIR, config.instanceId)
  if (!existsSync(sandboxDir)) {
    mkdirSync(sandboxDir, { recursive: true })
  }

  const preloadScript = generateTinPreloadScript(config.instanceId)
  const preloadPath = join(sandboxDir, 'preload.js')
  writeSecureFile(preloadPath, preloadScript)

  const wrappedHtml = wrapPanelHtml(config)
  const htmlPath = join(sandboxDir, 'panel.html')
  writeSecureFile(htmlPath, wrappedHtml)

  logger.debug(TAG, `Sandbox prepared: ${sandboxDir}`)
  return { htmlPath, preloadPath }
}

/**
 * 清理 Tin 沙箱文件和持久化 partition session 数据。
 *
 * 删除磁盘沙箱目录（HTML + preload），同时清除 Electron partition
 * 中的 localStorage / Cookie / IndexedDB 等，防止卸载后重装时
 * 被旧会话数据污染（TL-012）。
 */
export async function cleanupSandbox(instanceId: string): Promise<void> {
  if (!UUID_RE.test(instanceId)) return

  const sandboxDir = join(TIN_SANDBOX_DIR, instanceId)
  try {
    rmSync(sandboxDir, { recursive: true, force: true })
    logger.debug(TAG, `Sandbox files cleaned: ${sandboxDir}`)
  } catch (e) {
    logger.warn(TAG, `Failed to cleanup sandbox files ${instanceId}:`, e)
  }

  const partitionName = `persist:tin-${instanceId}`
  try {
    const partitionSession = session.fromPartition(partitionName)
    await partitionSession.clearStorageData()
    logger.debug(TAG, `Partition session cleaned: ${partitionName}`)
  } catch (e) {
    logger.warn(TAG, `Failed to cleanup partition session ${partitionName}:`, e)
  }
}

/** 生成 16 字节的 base64 nonce，用于 CSP script-src */
export function generateCspNonce(): string {
  return randomBytes(16).toString('base64')
}

// ── storage-manager 注册（W2.2 G1，business-app）────────────────
//
// Tin sandbox 由两部分构成：
//   1. {userData}/tin-sandboxes/{instanceId}/  ← 沙箱 HTML + preload（由本模块管）
//   2. {userData}/Partitions/persist%3Atin-{instanceId}/  ← Tin 应用自己写的 partition 数据
//
// sizeFn 同时统计两者，UI 才能给出真实的"清理后释放空间"预期。
// Partition 用顶层 readdir + stat 浅扫（不递归），Electron 在 partition 内部按
// 子目录（Local Storage / IndexedDB / Cookies / Cache 等）组织，浅扫一层就能
// 反映数量级；递归扫成千上万的 cache 文件会触线 < 1s 性能预算。

const TIN_PARTITIONS_DIR = join(app.getPath('userData'), 'Partitions')

async function _shallowDirSize(dir: string): Promise<number> {
  let total = 0
  let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isFile()) {
        const st = await stat(full)
        total += st.size
      } else if (entry.isDirectory()) {
        // 一层递归覆盖 partition 内 IndexedDB / Local Storage 等子目录
        const inner = await readdir(full, { withFileTypes: true })
        for (const child of inner) {
          if (!child.isFile()) continue
          try {
            const st = await stat(join(full, child.name))
            total += st.size
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return total
}

async function _tinPartitionSize(instanceId: string): Promise<number> {
  // Electron 把 partition 名 URL-encode 后作为目录名，`:` → `%3A`
  const partitionDir = join(TIN_PARTITIONS_DIR, `persist%3Atin-${instanceId}`)
  if (!existsSync(partitionDir)) return 0
  return _shallowDirSize(partitionDir)
}

async function _aggregateTinSandboxesSize(): Promise<{
  bytes: number
  itemCount: number
  entries: Array<{ instanceId: string; bytes: number; shellBytes: number; partitionBytes: number }>
}> {
  if (!existsSync(TIN_SANDBOX_DIR)) {
    return { bytes: 0, itemCount: 0, entries: [] }
  }

  let dirEntries: string[]
  try {
    dirEntries = await readdir(TIN_SANDBOX_DIR)
  } catch {
    return { bytes: 0, itemCount: 0, entries: [] }
  }

  // 并发对每个 instance 同时计算 shell 与 partition 体积，避免串行 readdir
  // 在多 Tin 实例下成为瓶颈。
  const results = await Promise.all(
    dirEntries.filter((name) => UUID_RE.test(name)).map(async (name) => {
      let shellBytes = 0
      try {
        const files = await readdir(join(TIN_SANDBOX_DIR, name))
        for (const file of files) {
          try {
            const st = await stat(join(TIN_SANDBOX_DIR, name, file))
            if (st.isFile()) shellBytes += st.size
          } catch {
            // ignore single file
          }
        }
      } catch {
        // 目录读取失败：shellBytes 保持 0
      }
      const partitionBytes = await _tinPartitionSize(name).catch(() => 0)
      return { instanceId: name, bytes: shellBytes + partitionBytes, shellBytes, partitionBytes }
    }),
  )

  const totalBytes = results.reduce((acc, r) => acc + r.bytes, 0)
  return { bytes: totalBytes, itemCount: results.length, entries: results }
}

// 注册函数幂等：重复调用会因 storage-manager 抛 BucketAlreadyRegisteredError，
// 在 try/catch 里吞掉，HMR / 测试场景下都安全。

export function registerTinSandboxBucket(): () => void {

  let unregister: (() => void) | undefined
  try {
    unregister = registerStorageBucket({
      id: 'tin:sandboxes',
      category: 'semi-cache',
      group: 'business-app',
      displayName: 'Tin 应用本地数据',
      description: 'Tin 应用运行所需的本地环境，包含 Tin 应用内自己存的登录状态、个人配置等。',
      warnings: [
        '清理后 Tin 实例下次打开会自动重建运行环境，应用本身仍可用',
        '⚠️ 你在 Tin 应用里登录过的账号会需要重登；Tin 应用内的本地笔记、个人配置等也会被一并清掉',
      ],
      requiresConfirmation: 'soft',
      sizeFn: async () => {
        const { bytes, itemCount } = await _aggregateTinSandboxesSize()
        return { bytes, itemCount }
      },
      listFn: async () => {
        const { entries } = await _aggregateTinSandboxesSize()
        return entries.map((entry) => ({
          id: entry.instanceId,
          label: `Tin 实例 ${entry.instanceId.slice(0, 8)}`,
          bytes: entry.bytes,
          metadata: {
            instanceId: entry.instanceId,
            shellBytes: entry.shellBytes,
            partitionBytes: entry.partitionBytes,
          },
        }))
      },
      clearFn: async (options) => {
        const { bytes, itemCount, entries } = await _aggregateTinSandboxesSize()

        if (options?.dryRun) {
          if (options.itemIds?.length) {
            const idSet = new Set(options.itemIds)
            let bytesEstimate = 0
            let countEstimate = 0
            for (const entry of entries) {
              if (idSet.has(entry.instanceId)) {
                bytesEstimate += entry.bytes
                countEstimate += 1
              }
            }
            return { clearedItemCount: countEstimate, freedBytes: bytesEstimate }
          }
          return { clearedItemCount: itemCount, freedBytes: bytes }
        }

        const target = options?.itemIds && options.itemIds.length > 0
          ? entries.filter((entry) => options.itemIds!.includes(entry.instanceId))
          : entries

        const errors: string[] = []
        let cleared = 0
        let freed = 0
        for (const entry of target) {
          try {
            await cleanupSandbox(entry.instanceId)
            cleared += 1
            freed += entry.bytes
          } catch (err) {
            errors.push(`${entry.instanceId}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        return { clearedItemCount: cleared, freedBytes: freed, errors: errors.length ? errors : undefined }
      },
    })
  } catch (err) {
    try { unregister?.() } catch { /* swallow */ }
    logger.warn(TAG, 'storage-manager bucket registration skipped:', err)
    return () => undefined
  }

  return () => {
    try { unregister?.() } catch { /* swallow */ }
  }
}

function generateEmptyPanelFallback(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:100vh;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    color:;text-align:center;padding:24px">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.5;margin-bottom:16px">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
      <line x1="3" y1="9" x2="21" y2="9"/>
      <line x1="9" y1="21" x2="9" y2="9"/>
    </svg>
    <div style="font-size:15px;font-weight:500;margin-bottom:8px">Tin 面板尚未就绪</div>
    <div style="font-size:13px;opacity:0.7;max-width:280px;line-height:1.5">
      该 Tin 的面板内容暂时无法加载。可能原因：面板代码尚未配置，或正在等待后端数据同步。
    </div>
  </div>`
}

function wrapPanelHtml(config: SandboxConfig): string {
  const { panelHtml, variables, pageContext } = config

  const effectiveHtml = panelHtml.trim() ? panelHtml : generateEmptyPanelFallback()

  const nonce = generateCspNonce()

  const allowedCdnOrigins = [
    'https://cdn.jsdelivr.net',
    'https://unpkg.com',
    'https://esm.sh',
    'https://cdnjs.cloudflare.com',
    'https://fonts.googleapis.com',
    'https://fonts.gstatic.com',
  ].join(' ')

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' ${allowedCdnOrigins}`,
    `style-src 'self' 'nonce-${nonce}' ${allowedCdnOrigins}`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data: ${allowedCdnOrigins}`,
    `connect-src 'self' https:`,
    `frame-src 'none'`,
  ].join('; ')

  const initScript = `
    <script nonce="${nonce}">
      window.__TIN_INIT__ = {
        variables: ${JSON.stringify(variables)},
        pageContext: ${JSON.stringify(pageContext)},
      };
    </script>
  `

  // SD-032: Always use our controlled HTML wrapper — never inject CSP into
  // user-provided <head>. Regex-based <head> detection can be bypassed by
  // placing a fake <head> inside an HTML comment, causing CSP to be injected
  // into the comment and leaving the real <head> unprotected.
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  ${initScript}
  <style nonce="${nonce}">
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      color: #1a1a2e;
      background: #ffffff;
      overflow-x: hidden;
    }
    @media (prefers-color-scheme: dark) {
      body { color: #e0e0e0; background: #1a1a2e; }
    }
  </style>
</head>
<body>
${effectiveHtml}
</body>
</html>`
}
