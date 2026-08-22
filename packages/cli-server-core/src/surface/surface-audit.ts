/**
 * Surface 调用审计日志。
 *
 * 每次 PlatformSurface handler 被调用，adapter（HTTP / IPC）在 handler
 * 前后包裹计时，调用此模块写入一行 JSONL 到本机审计目录。上线后用户
 * 报障时开发者拿 trace_id 直接 grep 这个文件就能定位。
 *
 * 写入路径：`~/.tabtin/audit-log/<module>/<YYYY-MM-DD>.jsonl`
 *   - module 从 surface.channel 的冒号前半部分取（如 `chat:export-md` → `chat`）
 *   - 按天分文件，避免单文件无限增长
 *
 * 设计约束：
 *   - 同步写（appendFileSync）——单行 JSONL 追加的 I/O 开销是微秒级，
 *     跟 desktop-audit-logger.ts 同款 pattern
 *   - try/catch 包裹——写失败静默，绝不阻塞业务
 *   - input 不记原始内容（隐私），只记 SHA-256 前 8 位 hex
 *   - mode 0o600——只有当前用户可读写
 */

import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'

// ─── 审计条目类型 ─────────────────────────────────────────────────

/** 一条 surface 调用审计记录。 */
export interface SurfaceAuditEntry {
  /** ISO 8601 时间戳 */
  timestamp: string
  /** surface channel，如 `chat:export-md` */
  channel: string
  /** trace_id（如有）——跨表 join 的关键 key */
  trace_id?: string
  /** input 的 SHA-256 前 8 位 hex（不记录原始输入，隐私保护） */
  input_hash: string
  /** handler 是否成功 */
  ok: boolean
  /** handler 执行耗时（毫秒） */
  duration_ms: number
  /** 失败时的错误码：SurfaceError.code 或 'INTERNAL_ERROR' */
  error_code?: string
}

// ─── 内部状态 ─────────────────────────────────────────────────────

/**
 * 惰性计算审计日志根目录——避免在模块加载时就调 getHomeTabtinPath()，
 * 让测试能在 beforeEach 里 mock homedir 后再触发路径计算。
 */
let _auditBaseDir: string | null = null
function _getAuditBaseDir(): string {
  if (!_auditBaseDir) {
    _auditBaseDir = getHomeTabtinPath('audit-log')
  }
  return _auditBaseDir
}

/**
 * 已确认创建的目录缓存——避免每次写入都调 mkdirSync。
 * 跟 desktop-audit-logger.ts 的 `auditDirEnsured` 同款 lazy init。
 */
const _ensuredDirs = new Set<string>()

// ─── 公共 API ─────────────────────────────────────────────────────

/**
 * 计算 input 的 SHA-256 前 8 位 hex。
 *
 * 用途：让开发者在 audit-log 里能比对"同一个 input 是否重复调用"，
 * 但不泄漏原始输入内容。8 hex = 32 bit，碰撞概率可接受（审计场景
 * 不需要密码学级唯一性）。
 */
export function _computeInputHash(input: unknown): string {
  let raw = ''
  try {
    raw = input !== undefined ? JSON.stringify(input) : ''
  } catch {
    raw = String(input)
  }
  return createHash('sha256').update(raw).digest('hex').slice(0, 8)
}

/**
 * 根据 channel 计算审计日志目录路径。
 *
 * channel 格式为 `module:verb`，取 module 作为子目录名：
 *   `chat:export-md` → `~/.tabtin/audit-log/chat/`
 *
 * 同一 module 下所有 verb 的审计日志聚合在同一目录，方便按模块 grep。
 */
export function _createAuditDir(channel: string): string {
  const namespace = channel.split(':')[0] || '_unknown'
  return join(_getAuditBaseDir(), namespace)
}

/**
 * 写入一条审计记录到 JSONL 文件。
 *
 * best-effort 策略：写失败静默，绝不抛异常、绝不阻塞业务。
 * 调用方（HTTP / IPC adapter）在 handler 前后构造 entry 传入即可。
 */
export function writeSurfaceAuditLog(entry: SurfaceAuditEntry): void {
  try {
    const dir = _createAuditDir(entry.channel)
    const dateStr = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
    const filePath = join(dir, `${dateStr}.jsonl`)
    const line = JSON.stringify(entry) + '\n'

    if (!_ensuredDirs.has(dir)) {
      mkdirSync(dir, { recursive: true })
      _ensuredDirs.add(dir)
    }
    appendFileSync(filePath, line, { mode: 0o600 })
  } catch {
    // best-effort：审计写入失败不阻塞 surface 调用
  }
}

// ─── 测试辅助 ─────────────────────────────────────────────────────

/**
 * 重置 `_ensuredDirs` 缓存——仅限测试使用。
 * 生产代码不应调用。
 */
export function __resetEnsuredDirsForTest(): void {
  _ensuredDirs.clear()
  _auditBaseDir = null
}
