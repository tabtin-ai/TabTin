/**
 * 统一的 FFmpeg 路径查找工具。
 * 所有需要调用 ffmpeg 的服务（AudioExtractor、TabVideoRender、VideoRenderer、VideoRecorder）
 * 应共享此模块，避免各自维护独立的查找逻辑。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'

const execFileAsync = promisify(execFile)
// ffmpeg-static 是可选 npm 包（生产打包时内嵌，开发期可能没装），用
// createRequire 保留延迟解析 + try/catch 容错。顶层 import 在缺包时会让整个
// 模块加载失败，破坏 fallback 链路。
const requireOptional = createRequire(import.meta.url)

let cachedPath: string | null = null

const SYSTEM_CANDIDATES = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
]

/**
 * 同步查找 ffmpeg 可执行文件路径。
 * 查找顺序：ffmpeg-static npm 包 → 应用内嵌 bin → 系统常见路径 → 系统 PATH。
 * 结果缓存，后续调用直接返回。
 *
 * @throws Error 如果所有候选路径均不可用
 */
export function findFFmpegSync(): string {
  if (cachedPath) return cachedPath

  // 1. ffmpeg-static（生产打包时可能内嵌）
  try {
    const ffmpegStatic = requireOptional('ffmpeg-static') as string | null
    if (ffmpegStatic && existsSync(ffmpegStatic)) {
      cachedPath = ffmpegStatic
      return ffmpegStatic
    }
  } catch { /* not installed */ }

  // 2. 应用本地 bin 目录
  try {
    const localPaths = [
      join(app.getAppPath(), 'bin', 'ffmpeg'),
      join(app.getAppPath(), '..', 'bin', 'ffmpeg'),
    ]
    for (const p of localPaths) {
      if (existsSync(p)) {
        cachedPath = p
        return p
      }
    }
  } catch { /* not in electron context */ }

  // 3. 系统常见路径（无需 execSync 验证，直接检测文件存在性）
  for (const candidate of SYSTEM_CANDIDATES) {
    if (existsSync(candidate)) {
      cachedPath = candidate
      return candidate
    }
  }

  // 4. 假设在 PATH 中（延迟到实际调用时验证）
  cachedPath = 'ffmpeg'
  return 'ffmpeg'
}

/**
 * 异步查找 ffmpeg，通过实际执行 `-version` 验证可用性。
 * @returns ffmpeg 路径，或 null（不可用时）
 */
export async function findFFmpegAsync(): Promise<string | null> {
  if (cachedPath && cachedPath !== 'ffmpeg') return cachedPath

  // 先尝试同步查找的结果
  const syncResult = findFFmpegSync()

  try {
    await execFileAsync(syncResult, ['-version'], { timeout: 5000 })
    cachedPath = syncResult
    return syncResult
  } catch {
    // 同步查找的结果不可用（可能是 fallback 的 'ffmpeg' 不在 PATH 中）
    cachedPath = null
    return null
  }
}

/**
 * 重置缓存（仅测试用）
 */
export function resetFFmpegCache(): void {
  cachedPath = null
}
