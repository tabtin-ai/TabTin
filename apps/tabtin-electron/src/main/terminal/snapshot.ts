/**
 * Terminal Snapshot — 终端快照序列化/反序列化/持久化
 *
 * 冷启动恢复：保存终端的 ANSI 输出快照到磁盘，
 * 下次启动时恢复到 xterm 中展示历史输出。
 */

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import fsp from 'fs/promises'
import { randomUUID } from 'crypto'
import { safeReadFileSync, isOSAccessError } from '@tabtin/safe-fs'
import { createLogger } from '../logger'
import type { TerminalSnapshot, SnapshotManifest } from '@shared/types/terminal'

const log = createLogger('Snapshot')

export type { TerminalSnapshot, SnapshotManifest, SnapshotCheckpointType } from '@shared/types/terminal'

// ── 敏感信息脱敏 ──

const REDACTED = '[REDACTED]'

/**
 * 脱敏正则列表：匹配常见的敏感信息模式。
 * 每条规则在序列化前对 ansiOutput 执行替换，不影响运行时终端显示。
 */
const SENSITIVE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  // Bearer token: "Bearer eyJ..." / "Bearer sk-..." (token 至少 20 字符，避免误伤描述性文本)
  { pattern: /\bBearer\s+[A-Za-z0-9_\-.]{20,}/gi, replacement: `Bearer ${REDACTED}` },
  // API keys: sk-xxx, sk_live_xxx, sk_test_xxx
  { pattern: /\bsk[-_][A-Za-z0-9_\-]{8,}\b/g, replacement: REDACTED },
  // token=xxx, api_key=xxx, api-key=xxx, apikey=xxx, secret=xxx, access_token=xxx
  { pattern: /\b(token|api[_-]?key|secret|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)=\S+/gi, replacement: `$1=${REDACTED}` },
  // export SECRET=xxx, export PASSWORD=xxx, export API_KEY=xxx 等
  { pattern: /\b(export\s+)([\w]*(?:SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH|CREDENTIALS?)[\w]*)=\S+/gi, replacement: `$1$2=${REDACTED}` },
  // 环境变量赋值（非 export）：PASSWORD=xxx, DB_PASSWORD=xxx, API_KEY=xxx 等
  { pattern: /(?:^|(?<=\s))([\w]*(?:SECRET|PASSWORD|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|AUTH|CREDENTIALS?)[\w]*)=(\S+)/gim, replacement: `$1=${REDACTED}` },
  // CLI 参数: --password xxx, --token xxx, --secret xxx, --api-key xxx
  { pattern: /(--(?:password|passwd|token|secret|api[_-]?key|access[_-]?token|private[_-]?key)[\s=])\S+/gi, replacement: `$1${REDACTED}` },
  // -p (短参数，后跟非 flag 的值，常见于 mysql -p)
  // 仅匹配 -p 后跟空格再跟非 - 开头的值
  { pattern: /(\s-p\s+)(?!-)(\S+)/g, replacement: `$1${REDACTED}` },
  // AWS 风格: AKIA... (20字符 access key ID)
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REDACTED },
  // GitHub personal access tokens: ghp_xxx, gho_xxx, ghs_xxx, ghr_xxx
  { pattern: /\bgh[posr]_[A-Za-z0-9_]{36,}\b/g, replacement: REDACTED },
]

/**
 * 对终端输出执行敏感信息脱敏。
 * 在快照序列化前调用，确保磁盘上不保存明文密码/token。
 */
export function redactSensitiveContent(text: string): string {
  let result = text
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    // 重置 lastIndex（全局正则需要）
    pattern.lastIndex = 0
    result = result.replace(pattern, replacement)
  }
  return result
}

const UNSAFE_SESSION_ID_PATTERN = /[./\\]/

export function isValidSnapshot(obj: unknown): obj is TerminalSnapshot {
  if (!obj || typeof obj !== 'object') return false
  const s = obj as Record<string, unknown>
  if (typeof s.sessionId !== 'string' || !s.sessionId) return false
  if (UNSAFE_SESSION_ID_PATTERN.test(s.sessionId)) return false
  return (
    typeof s.ansiOutput === 'string' &&
    typeof s.cwd === 'string' &&
    typeof s.cols === 'number' && Number.isInteger(s.cols) && s.cols > 0 &&
    typeof s.rows === 'number' && Number.isInteger(s.rows) && s.rows > 0 &&
    typeof s.capturedAt === 'number'
  )
}

const MAX_SNAPSHOT_CHARS = 500_000 // 字符数上限（约 500K 字符）
const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天过期
const MAX_AUTO_CHECKPOINTS_PER_SESSION = 10 // 每个 session 最多保留 10 个 auto checkpoint
const COLS_MISMATCH_THRESHOLD = 10 // cols 差距超过此值标记 sizeMismatch

let snapshotDirCached: string | null = null
const resolveUserDataPath = (): string => {
  try {
    const userDataPath = app?.getPath?.('userData')
    return typeof userDataPath === 'string' && userDataPath ? userDataPath : '/tmp'
  } catch {
    return '/tmp'
  }
}
const getSnapshotDir = (): string => {
  if (snapshotDirCached) return snapshotDirCached
  const dir = path.join(resolveUserDataPath(), 'terminal-snapshots')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // 收紧权限：仅当前用户可访问（recursive 模式下 mode 可能不生效于已存在目录）
  try { fs.chmodSync(dir, 0o700) } catch { /* best effort */ }
  snapshotDirCached = dir
  return dir
}

/**
 * 安全截断 ANSI 输出：从末尾截取指定字符数，
 * 确保截断后不会以不完整的 ANSI 转义序列开头，
 * 并在开头插入 reset 序列以清除残留颜色状态。
 */
function truncateAnsiSafe(output: string, maxChars: number): string {
  if (output.length <= maxChars) return output
  let truncated = output.slice(-maxChars)
  // 查找开头可能不完整的 ANSI 转义序列并移除
  // ANSI 序列格式: ESC [ ... 终止字符(字母)
  const firstEsc = truncated.indexOf('\x1b')
  if (firstEsc >= 0 && firstEsc < 20) {
    // 检查从该 ESC 开始的序列是否完整
    const afterEsc = truncated.slice(firstEsc)
    const seqMatch = afterEsc.match(/^\x1b\[[0-9;]*[A-Za-z]/)
    if (!seqMatch) {
      // 不完整序列，跳过到下一行
      const nextLine = truncated.indexOf('\n', firstEsc)
      if (nextLine >= 0) {
        truncated = truncated.slice(nextLine + 1)
      }
    }
  }
  // 在截断后前置 reset 序列，确保颜色状态干净
  return '\x1b[0m' + truncated
}

const getSnapshotPath = (sessionId: string): string => {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(getSnapshotDir(), `${safeId}.json`)
}

const getManifestPath = (): string => {
  return path.join(getSnapshotDir(), '_manifest.json')
}

function prepareSnapshotPayload(snapshot: TerminalSnapshot): string | null {
  let prepared = snapshot
  // 脱敏：在序列化前移除敏感信息（密码、token、API key 等）
  prepared = { ...prepared, ansiOutput: redactSensitiveContent(prepared.ansiOutput) }
  if (prepared.ansiOutput.length > MAX_SNAPSHOT_CHARS) {
    prepared = { ...prepared, ansiOutput: truncateAnsiSafe(prepared.ansiOutput, MAX_SNAPSHOT_CHARS) }
  }
  if (!prepared.ansiOutput.trim()) return null
  return JSON.stringify(prepared)
}

export function saveSnapshot(snapshot: TerminalSnapshot): boolean {
  try {
    const payload = prepareSnapshotPayload(snapshot)
    if (!payload) return false
    const filePath = getSnapshotPath(snapshot.sessionId)
    const tmpPath = filePath + '.tmp'
    fs.writeFileSync(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmpPath, filePath)
    return true
  } catch (err) {
    log.warn(`保存快照失败: ${snapshot.sessionId}`, err)
    return false
  }
}

/**
 * 加载快照。支持传入当前终端尺寸进行匹配校验。
 * 若 currentCols 与快照中的 cols 差距超过阈值，快照会被标记 sizeMismatch=true。
 * 差距过大时（cols 差 > 阈值）跳过恢复 ansiOutput，仅保留元信息。
 */
export function loadSnapshot(
  sessionId: string,
  currentSize?: { cols: number; rows: number },
): TerminalSnapshot | null {
  try {
    const filePath = getSnapshotPath(sessionId)
    if (!fs.existsSync(filePath)) return null
    const raw = safeReadFileSync(filePath, { encoding: 'utf-8' })
    const parsed = JSON.parse(raw)
    if (!isValidSnapshot(parsed)) return null
    if (Date.now() - parsed.capturedAt > SNAPSHOT_TTL_MS) {
      log.info(`快照已过期，丢弃: ${sessionId}`)
      deleteSnapshot(sessionId)
      return null
    }

    // P2-16 + W2-F4: 校验终端尺寸匹配（软校验）
    // sizeMismatch 标记仍设置，但保留 ansiOutput 让渲染端决定是否恢复
    if (currentSize) {
      const colsDiff = Math.abs(parsed.cols - currentSize.cols)
      if (colsDiff > COLS_MISMATCH_THRESHOLD) {
        log.info(
          `尺寸不匹配（软校验）: ${sessionId} ` +
          `(快照 ${parsed.cols}x${parsed.rows}, 当前 ${currentSize.cols}x${currentSize.rows}, cols 差 ${colsDiff})`,
        )
        return { ...parsed, sizeMismatch: true }
      }
    }

    return parsed
  } catch (err) {
    if (isOSAccessError(err)) {
      // OS 拦截（macOS TCC / Windows AV）: 拿到结构化提示便于 telemetry 排查
      log.warn(
        `加载快照被 OS 拒绝: ${sessionId} code=${err.osError.code} category=${err.osError.category}`,
      )
      return null
    }
    log.warn(`加载快照失败: ${sessionId}`, err)
    return null
  }
}

export function deleteSnapshot(sessionId: string): void {
  try {
    const filePath = getSnapshotPath(sessionId)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  } catch {
    // ignore
  }
}

export function saveManifest(manifest: SnapshotManifest): void {
  const filePath = getManifestPath()
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { encoding: 'utf-8', mode: 0o600 })
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* best effort */ }
    log.warn('保存 manifest 失败', err)
  }
}

async function saveManifestAsync(manifest: SnapshotManifest): Promise<void> {
  const filePath = getManifestPath()
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    await fsp.writeFile(tmpPath, JSON.stringify(manifest, null, 2), { encoding: 'utf-8', mode: 0o600 })
    await fsp.rename(tmpPath, filePath)
  } catch (err) {
    await fsp.unlink(tmpPath).catch(() => {})
    log.warn('异步保存 manifest 失败', err)
  }
}

export function loadManifest(): SnapshotManifest | null {
  try {
    const filePath = getManifestPath()
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SnapshotManifest
    if (!parsed.version || !Array.isArray(parsed.sessions)) return null
    return parsed
  } catch (err) {
    log.warn('加载 manifest 失败', err)
    return null
  }
}

/**
 * 异步保存单个快照（用于周期性批量保存，避免阻塞主进程）
 */
async function saveSnapshotAsync(snapshot: TerminalSnapshot): Promise<boolean> {
  try {
    const payload = prepareSnapshotPayload(snapshot)
    if (!payload) return false
    const filePath = getSnapshotPath(snapshot.sessionId)
    const tmpPath = filePath + '.tmp'
    await fsp.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 })
    await fsp.rename(tmpPath, filePath)
    return true
  } catch (err) {
    log.warn(`异步保存快照失败: ${snapshot.sessionId}`, err)
    return false
  }
}

/**
 * 异步批量保存（周期性 IPC handler 使用，不阻塞主进程事件循环）
 */
export async function saveAllSnapshotsAsync(
  snapshots: TerminalSnapshot[],
): Promise<{ saved: number; failed: number }> {
  let saved = 0
  let failed = 0
  const manifest: SnapshotManifest = { version: 1, capturedAt: Date.now(), sessions: [] }

  for (const snapshot of snapshots) {
    if (await saveSnapshotAsync(snapshot)) {
      saved++
      manifest.sessions.push({
        sessionId: snapshot.sessionId,
        cwd: snapshot.cwd,
        cols: snapshot.cols,
        rows: snapshot.rows,
      })
    } else {
      failed++
    }
  }

  if (saved > 0) {
    await saveManifestAsync(manifest)
    await cleanupOrphanSnapshotsAsync(manifest)
  }
  log.info(`异步保存快照: ${saved} 成功, ${failed} 失败`)
  return { saved, failed }
}

/**
 * 异步清理所有快照
 */
export async function clearAllSnapshotsAsync(): Promise<void> {
  try {
    const dir = getSnapshotDir()
    const files = await fsp.readdir(dir)
    await Promise.allSettled(files.map(f => fsp.unlink(path.join(dir, f))))
  } catch {
    // ignore
  }
}

/**
 * 同步批量保存（beforeunload 同步 IPC handler 使用）
 */
export function saveAllSnapshots(
  snapshots: TerminalSnapshot[],
): { saved: number; failed: number } {
  let saved = 0
  let failed = 0

  const manifest: SnapshotManifest = {
    version: 1,
    capturedAt: Date.now(),
    sessions: [],
  }

  for (const snapshot of snapshots) {
    if (saveSnapshot(snapshot)) {
      saved++
      manifest.sessions.push({
        sessionId: snapshot.sessionId,
        cwd: snapshot.cwd,
        cols: snapshot.cols,
        rows: snapshot.rows,
      })
    } else {
      failed++
    }
  }

  if (saved > 0) {
    saveManifest(manifest)
    cleanupOrphanSnapshots(manifest)
  }

  log.info(`保存快照: ${saved} 成功, ${failed} 失败`)
  return { saved, failed }
}

/**
 * 清理 manifest 中不存在的旧快照文件，防止磁盘累积。
 * 仅删除 .json 文件（排除 _manifest.json 和 .tmp 临时文件）。
 */
function buildActiveFileSet(manifest: SnapshotManifest): Set<string> {
  const set = new Set(
    manifest.sessions.map(s => {
      const safeId = s.sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      return `${safeId}.json`
    }),
  )
  set.add('_manifest.json')
  return set
}

function getOrphanFiles(allFiles: string[], manifest: SnapshotManifest): string[] {
  const activeFiles = buildActiveFileSet(manifest)
  return allFiles.filter(f => (f.endsWith('.json') || f.endsWith('.tmp')) && !activeFiles.has(f))
}

function cleanupOrphanSnapshots(manifest: SnapshotManifest): void {
  try {
    const dir = getSnapshotDir()
    const orphans = getOrphanFiles(fs.readdirSync(dir), manifest)
    for (const file of orphans) {
      try { fs.unlinkSync(path.join(dir, file)) } catch { /* ignore */ }
    }
    if (orphans.length > 0) {
      log.info(`清理孤儿快照: ${orphans.length} 个`)
    }
  } catch {
    // ignore
  }
}

async function cleanupOrphanSnapshotsAsync(manifest: SnapshotManifest): Promise<void> {
  try {
    const dir = getSnapshotDir()
    const orphans = getOrphanFiles(await fsp.readdir(dir), manifest)
    if (orphans.length === 0) return
    await Promise.allSettled(orphans.map(f => fsp.unlink(path.join(dir, f))))
    log.info(`异步清理孤儿快照: ${orphans.length} 个`)
  } catch {
    // ignore
  }
}

// ── Auto Checkpoint 专用逻辑 ──

let autoCheckpointDirCached: string | null = null
const getAutoCheckpointDir = (): string => {
  if (autoCheckpointDirCached) return autoCheckpointDirCached
  const dir = path.join(resolveUserDataPath(), 'terminal-snapshots', 'auto-checkpoints')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* best effort */ }
  autoCheckpointDirCached = dir
  return dir
}

/**
 * 生成 auto checkpoint 文件名：{sessionId}_{timestamp}.json
 */
function getAutoCheckpointPath(sessionId: string, timestamp: number): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(getAutoCheckpointDir(), `${safeId}_${timestamp}.json`)
}

/**
 * 异步保存一个 auto checkpoint（不阻塞命令执行）
 */
export async function saveAutoCheckpoint(snapshot: TerminalSnapshot): Promise<boolean> {
  try {
    const tagged: TerminalSnapshot = { ...snapshot, checkpointType: 'auto' }
    const payload = prepareSnapshotPayload(tagged)
    if (!payload) return false
    const filePath = getAutoCheckpointPath(snapshot.sessionId, snapshot.capturedAt)
    const tmpPath = filePath + '.tmp'
    await fsp.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 })
    await fsp.rename(tmpPath, filePath)
    log.info(`auto checkpoint 已保存: ${snapshot.sessionId}`)
    // 保存后执行清理（超出上限时淘汰最老的）
    await pruneAutoCheckpoints()
    return true
  } catch (err) {
    log.warn(`auto checkpoint 保存失败: ${snapshot.sessionId}`, err)
    return false
  }
}

/**
 * 提取文件名中的 sessionId 部分。
 * 文件名格式: {safeSessionId}_{timestamp}.json
 * 取最后一个 _数字.json 之前的部分作为 sessionId。
 */
function extractSessionIdFromFilename(filename: string): string {
  const match = filename.match(/^(.+)_\d+\.json$/)
  return match ? match[1] : filename
}

/**
 * 清理 auto checkpoint：每个 session 最多保留 MAX_AUTO_CHECKPOINTS_PER_SESSION 个。
 * P2-17: 改为 per-session 计数，避免多 session 并行时每个 session 实际可用配额被压缩。
 */
async function pruneAutoCheckpoints(): Promise<void> {
  try {
    const dir = getAutoCheckpointDir()
    const files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'))

    // 按 sessionId 分组
    const sessionFiles = new Map<string, string[]>()
    for (const f of files) {
      const sid = extractSessionIdFromFilename(f)
      if (!sessionFiles.has(sid)) sessionFiles.set(sid, [])
      sessionFiles.get(sid)!.push(f)
    }

    const toDelete: string[] = []
    for (const [, sFiles] of sessionFiles) {
      if (sFiles.length <= MAX_AUTO_CHECKPOINTS_PER_SESSION) continue
      // 按时间戳排序（升序），淘汰最老的
      sFiles.sort((a, b) => extractTimestampFromFilename(a) - extractTimestampFromFilename(b))
      toDelete.push(...sFiles.slice(0, sFiles.length - MAX_AUTO_CHECKPOINTS_PER_SESSION))
    }

    if (toDelete.length === 0) return
    await Promise.allSettled(toDelete.map(f => fsp.unlink(path.join(dir, f))))
    log.info(`auto checkpoint 清理: 删除 ${toDelete.length} 个旧快照（per-session 策略）`)
  } catch {
    // ignore
  }
}

function extractTimestampFromFilename(filename: string): number {
  // 文件名格式: {safeSessionId}_{timestamp}.json
  const match = filename.match(/_(\d+)\.json$/)
  return match ? Number(match[1]) : 0
}

/**
 * 列出所有 auto checkpoint（按时间倒序，最新在前）
 */
export async function listAutoCheckpoints(sessionId?: string): Promise<TerminalSnapshot[]> {
  try {
    const dir = getAutoCheckpointDir()
    let files = (await fsp.readdir(dir)).filter(f => f.endsWith('.json'))

    if (sessionId) {
      const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
      files = files.filter(f => f.startsWith(safeId + '_'))
    }

    // 按时间戳倒序
    files.sort((a, b) => extractTimestampFromFilename(b) - extractTimestampFromFilename(a))

    const results: TerminalSnapshot[] = []
    for (const file of files) {
      try {
        const raw = await fsp.readFile(path.join(dir, file), 'utf-8')
        const parsed = JSON.parse(raw)
        if (isValidSnapshot(parsed)) {
          results.push(parsed)
        }
      } catch {
        // skip invalid files
      }
    }
    return results
  } catch {
    return []
  }
}
