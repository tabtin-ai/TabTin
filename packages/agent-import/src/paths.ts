/**
 * 四家工具的候选路径表（PRD §5.3）。
 *
 * 硬编码是安全特性：白名单可配置 = 导入器沦为任意文件读取器。
 * 官方 env 覆盖仅两家：CODEX_HOME、CLAUDE_CONFIG_DIR。
 * Electron 系应用数据根按平台分支（与 LocalMcpService / tabtin-shared 对齐）：
 *   macOS → ~/Library/Application Support/<App>
 *   Windows → %APPDATA%/<App>
 *   Linux → $XDG_CONFIG_HOME/<App> 或 ~/.config/<App>
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { ImportIO } from './io.js'
import type { ImportSource } from './types.js'

export interface SourcePaths {
  source: ImportSource
  /** 数据根（存在性探测的第一级） */
  roots: string[]
  /** 额外关键文件/目录（索引所在） */
  extras: Record<string, string>
}

/**
 * Cursor / Claude Desktop 等 Electron 应用的 userData 根目录。
 * 仅用于白名单硬编码分支，不接受调用方自定义根。
 */
export function resolveVendorAppDataDir(io: ImportIO, appName: string): string {
  if (!appName || appName.includes('..') || appName.includes('/') || appName.includes('\\')) {
    throw new Error(`非法 vendor appName: ${appName}`)
  }
  const home = io.homedir()
  const platform = io.platform()
  if (platform === 'win32') {
    const appData = io.env('APPDATA') || path.join(home, 'AppData', 'Roaming')
    return path.join(appData, appName)
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', appName)
  }
  const configHome = io.env('XDG_CONFIG_HOME') || path.join(home, '.config')
  return path.join(configHome, appName)
}

export function resolveSourcePaths(io: ImportIO, source: ImportSource): SourcePaths {
  const home = io.homedir()
  switch (source) {
    case 'claude_code': {
      const configDir = io.env('CLAUDE_CONFIG_DIR') || path.join(home, '.claude')
      const claudeAppData = resolveVendorAppDataDir(io, 'Claude')
      return {
        source,
        roots: [configDir],
        extras: {
          projectsDir: path.join(configDir, 'projects'),
          /** ~/.claude.json 是 home 下独立文件（项目注册表 + 信任状态），不在 .claude 目录内 */
          globalConfig: path.join(home, '.claude.json'),
          /** Desktop 侧会话索引（标题正典，join 键 cliSessionId） */
          desktopSessionsDir: path.join(claudeAppData, 'claude-code-sessions'),
        },
      }
    }
    case 'codex': {
      const codexHome = io.env('CODEX_HOME') || path.join(home, '.codex')
      return {
        source,
        roots: [codexHome],
        extras: {
          sessionsDir: path.join(codexHome, 'sessions'),
          archivedSessionsDir: path.join(codexHome, 'archived_sessions'),
          /** threads 表权威索引（816 行实测），持锁需 copySnapshot */
          stateDb: path.join(codexHome, 'state_5.sqlite'),
        },
      }
    }
    case 'cursor': {
      const cursorHome = path.join(home, '.cursor')
      const cursorAppData = resolveVendorAppDataDir(io, 'Cursor')
      const globalStorage = path.join(cursorAppData, 'User', 'globalStorage')
      return {
        source,
        roots: [cursorHome, globalStorage],
        extras: {
          projectsDir: path.join(cursorHome, 'projects'),
          /** composerHeaders 专用表所在（15.78GB，readonly 直开勿拷贝） */
          stateDb: path.join(globalStorage, 'state.vscdb'),
          /** 一次性救援源（756 会话气泡），无 wal 需 immutable=1 */
          stateDbBackup: path.join(globalStorage, 'state.vscdb.backup'),
          /** 图片二段寻址：<hash>/workspace.json 与 <hash>/images/（PRD §5.3 限定范围） */
          workspaceStorageDir: path.join(cursorAppData, 'User', 'workspaceStorage'),
        },
      }
    }
    case 'workbuddy': {
      const wbHome = path.join(home, '.workbuddy')
      return {
        source,
        roots: [wbHome],
        extras: {
          db: path.join(wbHome, 'workbuddy.db'),
          projectsDir: path.join(wbHome, 'projects'),
          blobsDir: path.join(wbHome, 'blobs'),
        },
      }
    }
  }
}

/** Claude Desktop 凭据文件名（含 Chromium Cookies-journal 旁路）。 */
const CLAUDE_DESKTOP_SECRET_NAMES = new Set([
  'cookies',
  'cookies-journal',
  'config.json',
  'buddy-tokens.json',
])

/**
 * 红线路径判定（PRD §2.7）：无论任何调用路径，这些文件绝不读取。
 * adapter 层白名单之外的第二道保险；宿主 IO 实现应在读文件前调用。
 *
 * 传入 `io` 时，还会按解析后的 Claude appData 根判定（覆盖自定义 APPDATA /
 * XDG_CONFIG_HOME，不依赖路径段名 Roaming/.config）。
 */
export function isForbiddenPath(p: string, io?: ImportIO): boolean {
  const norm = p.replace(/\\/g, '/')
  if (FORBIDDEN_PATTERNS.some((re) => re.test(norm))) return true
  if (io) {
    const claudeRoot = resolveVendorAppDataDir(io, 'Claude').replace(/\\/g, '/').replace(/\/$/, '')
    if (norm === claudeRoot || norm.startsWith(`${claudeRoot}/`)) {
      const base = path.posix.basename(norm).toLowerCase()
      if (CLAUDE_DESKTOP_SECRET_NAMES.has(base)) return true
    }
  }
  return false
}

const FORBIDDEN_PATTERNS: RegExp[] = [
  /\/\.codex\/auth\.json$/i,
  /\/\.claude\/settings(\.local)?\.json$/i,
  // Claude Desktop 凭据（段名启发式；自定义 APPDATA 时靠 isForbiddenPath(p, io)）
  /\/Claude\/(Cookies(?:-journal)?|config\.json|buddy-tokens\.json)$/i,
  /\/\.workbuddy\/(credentials|connectors)\//i,
  /\/\.cursor\/cli-config\.json$/i,
  /\/shell-snapshots\//i,
  // Cursor ItemTable 凭据 key 由 cursor adapter 的 SQL 白名单排除（cursorAuth/% 等
  // 前缀不出现在任何查询里）；文件级无法拦，列于此备忘。
]

function realpathOrResolve(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    // 文件尚不存在时（或中间目录是 symlink）退回 resolve；调用方仍会因读失败而停。
    return path.resolve(p)
  }
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = realpathOrResolve(candidate)
  const resolvedRoot = realpathOrResolve(root)
  return (
    resolvedCandidate === resolvedRoot
    || resolvedCandidate.startsWith(resolvedRoot + path.sep)
  )
}

/**
 * 解析后的会话文件必须落在该 source 的白名单根/extras 内，且非红线路径。
 * 阻止客户端伪造 sourcePath 读任意本机 JSONL（ 阻塞项 1）。
 */
export function assertImportSourcePath(
  io: ImportIO,
  source: ImportSource,
  filePath: string,
): void {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('sourcePath 无效')
  }
  if (isForbiddenPath(filePath, io)) {
    throw new Error(`拒绝读取红线路径: ${filePath}`)
  }
  const { roots, extras } = resolveSourcePaths(io, source)
  const allowed = [...roots, ...Object.values(extras)]
  const ok = allowed.some((root) => root && isPathInsideRoot(filePath, root))
  if (!ok) {
    throw new Error(`sourcePath 不在 ${source} 白名单根目录内: ${filePath}`)
  }
}
