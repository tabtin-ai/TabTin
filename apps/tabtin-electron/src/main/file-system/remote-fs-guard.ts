/**
 * 远程 fs action 的 working_dir 边界判定。
 */
import fsPromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createPathAccessChecker, type PathAccessChecker } from '../security/path-access-checker'
import { createLogger } from '../logger'

const log = createLogger('RemoteFsGuard')

export interface RemoteFsResult {
  success: boolean
  data?: Record<string, unknown>
  error?: string
  error_code?: string
}

function createRemoteChecker(workingDir: string): PathAccessChecker {
  return createPathAccessChecker({
    getAllowedPaths: () => [workingDir],
    // 刻意为空：远程浏览不放行 home/downloads 等平台路径
    getPlatformAllowedDirs: () => [],
    homeDir: process.env.HOME ?? os.homedir(),
  })
}

/** SessionShare 物化入参：相对路径规范化（拒绝对路径 / scheme / 越界 ..）。 */
export function canonicalizeRelativePath(input: string): string | null {
  const cleaned = String(input ?? '').trim()
  if (!cleaned) return null
  if (
    cleaned.startsWith('/')
    || cleaned.startsWith('~')
    || /^[a-zA-Z]:[\\/]/.test(cleaned)
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(cleaned)
  ) {
    return null
  }
  const segments = cleaned.replace(/\\/g, '/').split('/')
  const out: string[] = []
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.length === 0 ? null : out.join('/')
}

export async function resolveGuardedPath(
  workingDir: string,
  rawPath: string,
): Promise<{ resolved: string; realRoot: string } | RemoteFsResult> {
  if (!workingDir) {
    // _working_dir 由 Django 服务端注入；缺失说明请求没走正规链路，fail-closed。
    return { success: false, error: 'missing authoritative working_dir', error_code: 'INVALID_REQUEST' }
  }
  if (!rawPath) {
    return { success: false, error: 'path is required', error_code: 'INVALID_REQUEST' }
  }

  // symlink 防逃逸：边界判定必须用 realpath（root 和 target 都要），否则
  // working_dir 内一条指向外部的软链（link -> /etc）字符串前缀判定放行、
  // 实际 readdir/readFile 却 follow 到边界外。realpath 失败（不存在等）与
  // 拒绝统一 PATH_DENIED 口径（防目录结构探测）。
  let realRoot: string
  let resolved: string
  try {
    realRoot = await fsPromises.realpath(path.resolve(workingDir))
    const candidate = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(realRoot, rawPath)
    resolved = await fsPromises.realpath(candidate)
  } catch {
    log.warn('denied（realpath 失败）', { name: path.basename(rawPath), reason: 'realpath_failed' })
    return { success: false, error: 'path is not accessible', error_code: 'PATH_DENIED' }
  }

  const checker = createRemoteChecker(realRoot)
  const access = checker.check(resolved, 'read')
  if (!access.allowed) {
    // 不透传 checker 的具体 reason 文案，只给远端一个统称码。
    log.warn('denied（access check）', { name: path.basename(resolved), reason: access.reason?.reasonCode })
    return { success: false, error: 'path is not accessible', error_code: 'PATH_DENIED' }
  }
  return { resolved, realRoot }
}
