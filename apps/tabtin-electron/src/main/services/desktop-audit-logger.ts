/**
 * 桌面操控审计日志——共享工具 + 单事实源约束。
 *
 * v1.3 → v1.4 · Wave 2 变更（规范 § 6.11 / § 9.2 第 6 条 / § 10 Q9）：
 *
 * **单事实源**：`~/.tabtin/desktop-audit-{YYYY-MM}.jsonl`（mode 0o600）。
 * Executor 和 Route 层对审计的写入统一走 {@link writeAuditLog}，
 * 不再让 `electron-log` 额外落盘 `desktop-audit.log` 文件——那份双轨 log 的
 * schema 与 jsonl 不一致，容易让消费方误以为是同一份数据。
 *
 * 降级后的 `desktopAuditLogger`（electron-log 实例）：
 * - 仅输出 **console.debug 级**（开发期与排障用）
 * - 文件 transport 显式关闭（`transports.file.level = false`）
 * - 保留向后兼容的 `.info()` API，让 DesktopUseGuard 等旧调用位不至于崩
 *   （真正的持久化由 writeAuditLog 走 jsonl 承担，Guard 的"approval_granted /
 *    approval_denied"这类事件不进 jsonl 是刻意设计——jsonl 只记 audited
 *    action，授权事件走 debug console 给排障看即可）
 *
 * v1.4 → v1.5 · W1.3 变更（本地存储清单 A1-H3 / storage-manager 总控 §五 W1.3）：
 *
 * **按月分片 + 6 月保留窗口**。历史上 `~/.tabtin/desktop-audit.jsonl` 是
 * 单文件 append-only，零 rotation——重度桌面操控用户每天数百次 click /
 * type / screenshot，几个月后能膨胀到 GB 级。现状改造为：
 *
 *   - 当前活跃文件：`desktop-audit-YYYY-MM.jsonl`（按写入时刻的 UTC 月份分片）
 *   - 保留窗口：当前月 + 过去 5 个月 = 最近 6 个月
 *   - 超出 6 月的文件移入 `desktop-audit-archive/` 子目录（合规审计性质，
 *     不能直接删——`data` 类型的硬约束）
 *   - 启动期 lazy migration：第一次 writeAuditLog 调用时检测旧版单文件
 *     `~/.tabtin/desktop-audit.jsonl`，按其 mtime 月份归档进对应分片，
 *     避免 v1.4 → v1.5 升级时丢历史审计数据
 *
 * **线程安全**：`appendFileSync` 单 tick 内的并发安全由 OS append 保证；
 * migration / cleanup 是 process-once 操作，由模块级 flag 守护——多线程
 * 写入时不会重复 migrate。跨月份临界点（月底零点）：因为每次 write 都
 * 实时计算 month key，临界点的写入会"自动落到正确的月份文件"，无需 race
 * 处理；唯一边界是新月份首次写入触发 cleanup（同 process-once）。
 *
 * **AUDIT_LOG_JSONL_PATH 兼容**：旧导出仍指向 legacy 单文件路径
 * `~/.tabtin/desktop-audit.jsonl` —— 给 migration 扫描器和外部消费方
 * 一个稳定的"历史路径"参考。当前活跃路径请用 {@link getActiveAuditLogPath}。
 */

import {
  appendFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { join, basename } from 'node:path'
import electronLog from 'electron-log'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { createLogger } from '../logger'
import { DesktopErrorCode } from './desktop-error-codes'

// 用于把"审计写入失败"上报到主进程统一 logger（生产环境写 main.log，
// 让 OPS 真能看到）。注意：这条 logger 不做审计本身，只做"审计失败"
// 的元事件上报——审计落盘走 jsonl，元事件走 main.log，互不干扰。
const log = createLogger('DesktopAudit')

// ---------------------------------------------------------------------------
// electron-log 实例（降级为 debug 级 console，不再写文件）
// ---------------------------------------------------------------------------

export const desktopAuditLogger = electronLog.create({ logId: 'desktop-audit' })
// 关闭文件 transport：v1.4 开始 ~/.tabtin/desktop-audit.log 不再被创建。
desktopAuditLogger.transports.file.level = false
// console 保留 debug 级：仅开发期排障用，线上不污染用户可见 console。
desktopAuditLogger.transports.console.level = 'debug'

// ---------------------------------------------------------------------------
// jsonl 唯一事实源（按月分片 · v1.5）
// ---------------------------------------------------------------------------

const AUDIT_LOG_DIR = getHomeTabtinPath()
const LEGACY_AUDIT_LOG_PATH = join(AUDIT_LOG_DIR, 'desktop-audit.jsonl')
/**
 * Migration sentinel：开始迁移前把 legacy 文件 rename 成这个名字，迁移完成
 * 后 unlinkSync 删除。下次启动看到 sentinel 残留 = 上次 migration 中段崩溃，
 * 此时 target 月份分片可能已部分写入——为避免重复审计数据，**保留 sentinel
 * 不再重做**，把它 rename 成 .orphan-{ts} 备查（合规审计性质，不能删）。
 */
const LEGACY_AUDIT_MIGRATING_PATH = join(AUDIT_LOG_DIR, 'desktop-audit.jsonl.migrating')
const AUDIT_LOG_FILENAME_PREFIX = 'desktop-audit-'
const AUDIT_LOG_FILENAME_SUFFIX = '.jsonl'
const ARCHIVE_DIR = join(AUDIT_LOG_DIR, 'desktop-audit-archive')

/**
 * 保留最近多少个月的审计文件不归档。
 * 6 = 当前月 + 过去 5 个月。再老的进 archive 子目录。
 */
const RETENTION_MONTHS = 6

let auditDirEnsured = false
let migrationDone = false
/**
 * 上一次执行 cleanup 时的月份 key（YYYY-MM）。当 writeAuditLog 检测到
 * 当前月份与此值不同（跨月）时重置 cleanup 触发标志，让长寿命进程在
 * 跨月时也能扫一次老分片归档——避免"启动那天扫了，6 个月后还在跑的
 * 进程从此不再清理"的退化（R1 review 修复）。
 */
let lastCleanupMonth: string | null = null

/** 审计日志的一条记录——schema 对齐规范 § 6.11.2。 */
export interface AuditLogEntry {
  /** 动作名（如 `click` / `screenshot` / `batch_step.2.type`） */
  action: string
  /** 所属 session；路由层未建 session 时为 `null` */
  sessionId?: string | null
  /** 规整后的请求参数（已脱敏） */
  params: Record<string, unknown>
  /** 简明结果标签，替代旧版自由文本 */
  result: 'ok' | 'error'
  /** `result === 'error'` 时必填（规范 § 6.11.2） */
  errorCode?: DesktopErrorCode
  /** 用户可见中文文案前 200 字符（便于人工查 log 时直接看懂） */
  errorMessage?: string
}

/**
 * 审计参数脱敏（与旧路由实现保持一致的行为）。
 * - `_authPreset` 字段一律剔除（PD-11 之前的内部 hint；字段虽已从 W6 M3 起从
 *   路由 schema 中删除，但保留剔除逻辑是防御性兜底——避免未来某个调试 / 中
 *   间件意外塞回该 key 时被审计 log 误收）
 * - `text` 字段超 100 字符截断 + "..." 尾标
 * - `savePath` 只保留 basename，避免暴露用户目录结构
 */
export function sanitizeAuditParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(params ?? {})) {
    if (k === '_authPreset') continue
    if (k === 'text' && typeof v === 'string') {
      result[k] = v.length > 100 ? v.slice(0, 100) + '...' : v
    } else if (k === 'savePath' && typeof v === 'string') {
      result[k] = basename(v)
    } else {
      result[k] = v
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// 月份分片 helper
// ---------------------------------------------------------------------------

/** 把 Date 转成 `YYYY-MM`（UTC，用 UTC 避免跨时区用户文件名漂移）。 */
export function formatMonthKey(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** 给定月份 key（YYYY-MM），返回该月份审计文件的绝对路径。 */
function monthFilePath(monthKey: string): string {
  return join(AUDIT_LOG_DIR, `${AUDIT_LOG_FILENAME_PREFIX}${monthKey}${AUDIT_LOG_FILENAME_SUFFIX}`)
}

/**
 * 当前活跃审计文件的绝对路径（按当前 UTC 月份）。供测试与外部消费方引用。
 */
export function getActiveAuditLogPath(now: Date = new Date()): string {
  return monthFilePath(formatMonthKey(now))
}

/**
 * 把月份 key（YYYY-MM）转成可比较的整数（YYYY*100 + MM）。
 * 仅用于 cleanup 阶段判断"是否在 6 月窗口内"。
 */
function monthKeyToOrdinal(monthKey: string): number {
  const m = monthKey.match(/^(\d{4})-(\d{2})$/)
  if (!m) return Number.NEGATIVE_INFINITY
  return Number(m[1]) * 100 + Number(m[2])
}

/**
 * 计算"6 个月窗口的最早月份"——超过此月份（含）的保留，更早的归档。
 *
 * 例：今天 2026-05，retention=6 → 最早保留月份 = 2025-12（5 月本身 + 4/3/2/1/12）。
 */
function earliestRetainedMonth(now: Date): number {
  const y = now.getUTCFullYear()
  const m = now.getUTCMonth() + 1 // 1-12
  // 把 (y, m) - (RETENTION_MONTHS - 1) 月转成 ordinal
  const totalMonths = y * 12 + (m - 1) - (RETENTION_MONTHS - 1)
  const ey = Math.floor(totalMonths / 12)
  const em = (totalMonths % 12) + 1
  return ey * 100 + em
}

// ---------------------------------------------------------------------------
// 启动期 migration + cleanup（lazy，第一次写入时执行，process-once）
// ---------------------------------------------------------------------------

/**
 * v1.4 → v1.5 升级一次性 migration：把旧版单文件 `desktop-audit.jsonl`
 * 的内容并到对应月份分片文件（按 mtime 决定归属月份），然后 unlink 旧文件。
 *
 * **W1.3 / R2 F1 修复（流式 + 异步）**：legacy 文件可能 GB 级，原同步
 * `readFileSync` + `appendFileSync` 实现会吃内存且阻塞主进程几秒；
 * 改用 `pipeline(createReadStream, createWriteStream)` 流式异步迁移，
 * 内存常数（64KB chunk），不阻塞主线程。
 *
 * **W1.3 / R2 F2 修复（sentinel 幂等）**：开始迁移前把 legacy 文件
 * rename 成 `desktop-audit.jsonl.migrating`，迁移完成后才 unlink；
 * 下次启动看到 sentinel 残留 = 上次崩溃，此时 target 月份分片可能已部分
 * 写入——**保留 sentinel 不再重做**，把它 rename 成 `.orphan-{ts}` 备查
 * （合规审计性质，不能删；让运维 / 用户决定后续处置）。
 *
 * 失败 best-effort（不抛）。由 {@link initDesktopAuditLogger} 在启动期触发；
 * 旧"首次写入触发"的同步路径已下线（migrationDone 改成只读 flag）。
 */
async function migrateLegacyIfNeeded(): Promise<void> {
  if (migrationDone) return
  migrationDone = true
  try {
    // 检测上次崩溃残留的 sentinel 文件——保留备查不重做
    if (existsSync(LEGACY_AUDIT_MIGRATING_PATH)) {
      const orphanPath = `${LEGACY_AUDIT_MIGRATING_PATH}.orphan-${Date.now()}`
      try {
        renameSync(LEGACY_AUDIT_MIGRATING_PATH, orphanPath)
        desktopAuditLogger.debug?.(
          `[desktop-audit-logger] legacy migration sentinel detected (last run crashed), preserved as: ${orphanPath}`,
        )
      } catch (renameErr) {
        desktopAuditLogger.debug?.(
          `[desktop-audit-logger] failed to preserve sentinel orphan (best-effort): ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`,
        )
      }
      return
    }

    if (!existsSync(LEGACY_AUDIT_LOG_PATH)) return
    const stat = statSync(LEGACY_AUDIT_LOG_PATH)
    if (stat.size === 0) {
      try { unlinkSync(LEGACY_AUDIT_LOG_PATH) } catch { /* best-effort */ }
      return
    }
    // 确保目标目录存在（migration 可能比首次 writeAuditLog 更早跑）
    if (!auditDirEnsured) {
      mkdirSync(AUDIT_LOG_DIR, { recursive: true })
      auditDirEnsured = true
    }
    // 历史文件按 mtime 决定它"主要属于"哪个月份；不试图按内容里的 timestamp
    // 切片归类——rolling 窗口里旧 jsonl 的写入时间普遍集中在末尾的最后一两月，
    // mtime 已经是足够好的近似，避免按行解析 + 重切的复杂度。
    const targetMonth = formatMonthKey(stat.mtime)
    const targetFile = monthFilePath(targetMonth)

    // Sentinel: rename 即原子获取迁移所有权 + 阻断 writeAuditLog 期间外部干扰
    renameSync(LEGACY_AUDIT_LOG_PATH, LEGACY_AUDIT_MIGRATING_PATH)

    // 流式 append：每 chunk 64KB，常数内存，不阻塞 event loop
    const readStream = createReadStream(LEGACY_AUDIT_MIGRATING_PATH, {
      highWaterMark: 64 * 1024,
    })
    const writeStream = createWriteStream(targetFile, {
      flags: 'a', // append 模式，不覆盖现有月份分片内容
      mode: 0o600,
    })
    await pipeline(readStream, writeStream)

    // 迁移完成才删 sentinel
    unlinkSync(LEGACY_AUDIT_MIGRATING_PATH)
    desktopAuditLogger.debug?.(
      `[desktop-audit-logger] legacy migration complete: ${LEGACY_AUDIT_LOG_PATH} → ${targetFile} (${stat.size} bytes)`,
    )
  } catch (err) {
    // best-effort：migration 失败不阻塞首次写入；sentinel 在崩溃时保留
    desktopAuditLogger.debug?.(
      `[desktop-audit-logger] legacy migration failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * 扫描 `~/.tabtin/` 下所有 `desktop-audit-YYYY-MM.jsonl` 文件，超过 6 月
 * 保留窗口的移到 `desktop-audit-archive/`。失败 best-effort。
 *
 * **触发节奏**：每次写入时计算当月 key，若与上次 cleanup 时的月份不同
 * 才执行一次。这意味着：
 *   - 短寿命进程（一次启动只持续几小时）：进程内只扫一次（首写时）
 *   - 长寿命进程（Agent 模式可跑数月）：跨月时自动再扫一次
 *
 * 这避免了 "启动那天扫了，6 月后老分片永远不会被归档" 的退化场景。
 */
function cleanupOldShardsIfNeeded(now: Date): void {
  const currentMonth = formatMonthKey(now)
  if (lastCleanupMonth === currentMonth) return
  lastCleanupMonth = currentMonth
  try {
    if (!existsSync(AUDIT_LOG_DIR)) return
    const cutoff = earliestRetainedMonth(now)
    const entries = readdirSync(AUDIT_LOG_DIR)
    const pattern = /^desktop-audit-(\d{4}-\d{2})\.jsonl$/
    for (const name of entries) {
      const m = name.match(pattern)
      if (!m) continue
      const ord = monthKeyToOrdinal(m[1])
      if (ord >= cutoff) continue // 在保留窗口内
      const src = join(AUDIT_LOG_DIR, name)
      const dst = join(ARCHIVE_DIR, name)
      try {
        mkdirSync(ARCHIVE_DIR, { recursive: true })
        renameSync(src, dst)
        desktopAuditLogger.debug?.(
          `[desktop-audit-logger] archived old shard: ${name}`,
        )
      } catch (err) {
        desktopAuditLogger.debug?.(
          `[desktop-audit-logger] archive failed for ${name} (best-effort): ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  } catch (err) {
    desktopAuditLogger.debug?.(
      `[desktop-audit-logger] cleanup scan failed (best-effort): ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 写入主入口
// ---------------------------------------------------------------------------

/**
 * 写入一条审计记录到当前月份的分片文件 `~/.tabtin/desktop-audit-YYYY-MM.jsonl`。
 *
 * 失败采用 best-effort 策略（不阻塞主流程、不抛异常）。v1.4 前同时写入
 * `electron-log desktop-audit.log` 的双轨路径已移除——只走 jsonl + console debug。
 *
 * v1.5 起按写入时刻 UTC 月份自动选择文件，并在第一次调用时一次性 migrate
 * 旧版单文件并归档超出 6 月保留窗口的旧分片。
 *
 * @param entry 一条完整的 AuditLogEntry；调用方需保证：
 *   - `result === 'error'` 时**必须**提供 `errorCode`（规范 § 6.11.2 硬约束，
 *     本函数做开发期断言但不阻塞运行）
 *   - `params` 已完成脱敏（或由 {@link sanitizeAuditParams} 二次清洗）
 */
export function writeAuditLog(entry: AuditLogEntry): void {
  if (entry.result === 'error' && !entry.errorCode) {
    // 开发期显性提示调用方忘记填 errorCode；生产环境不阻塞。
    try {
      desktopAuditLogger.debug(
        `[writeAuditLog] BUG: result='error' 记录缺少 errorCode (action=${entry.action})`,
      )
    } catch { /* best-effort */ }
  }

  const now = new Date()
  const record = {
    timestamp: now.toISOString(),
    sessionId: entry.sessionId ?? null,
    action: entry.action,
    params: sanitizeAuditParams(entry.params),
    result: entry.result,
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.errorMessage
      ? { errorMessage: entry.errorMessage.slice(0, 200) }
      : {}),
  }

  try {
    if (!auditDirEnsured) {
      mkdirSync(AUDIT_LOG_DIR, { recursive: true })
      auditDirEnsured = true
    }
    // 月份分片节流的 archive 扫盘（同月仅一次，跨月时重置）
    cleanupOldShardsIfNeeded(now)
    appendFileSync(
      getActiveAuditLogPath(now),
      JSON.stringify(record) + '\n',
      { mode: 0o600 },
    )
  } catch (err) {
    // best-effort：审计写入失败不阻塞操控请求。
    //
    // **W1.3 / R2 F2 修复（OPS 可观测）**：以前 catch 直接吞错，磁盘满 /
    // `~/.tabtin/` 权限错 / ENOSPC 时审计静默停掉，OPS 复盘"上周 desktop_control
    // 审计为什么没数据"找不到原因。
    //
    // **R2 第二轮修复**：第一版用 `console.warn`，但 packaged 模式下 stdout
    // 被丢弃 → OPS 仍然看不到。改用主进程 `createLogger('DesktopAudit').warn(...)`：
    //   - 开发环境：走 console.warn → 直接看到
    //   - 生产环境：走 electron-log scope file transport → 写入 main.log
    //     （路径：macOS `~/Library/Logs/TabTin/main.log` / Linux
    //     `~/.config/TabTin/logs/main.log` / Windows `%APPDATA%\TabTin\logs\main.log`）
    // 这样 OPS 远程排障时只需 tail main.log 即可看到 audit 失败事件。
    //
    // **不用 desktopAuditLogger 自己的原因**：那个局部实例 `electronLog.create({logId:'desktop-audit'})`
    // 显式关掉了 file transport（行 67），直接调它失败信息也写不到文件——
    // 只有走主进程共享的 `createLogger`（基于 default `electronLog`）才会
    // 落到 main.log。
    try {
      log.warn(
        '[desktop-audit-logger] append failed (audit data dropped):',
        err,
      )
    } catch { /* best-effort, 连 logger 都失败不再升级处理 */ }
  }

  // debug 级镜像到 console，便于本地排障；不再落文件。
  try {
    desktopAuditLogger.debug(JSON.stringify(record))
  } catch { /* best-effort */ }
}

/**
 * 审计日志 jsonl legacy 路径——v1.4 之前的单文件位置。
 *
 * v1.5 起活跃写入路径改用 `getActiveAuditLogPath()`（按月分片），但本常量
 * 保留导出，作为：
 *   1. v1.4 → v1.5 migration 扫描的源路径
 *   2. 外部审计消费方"历史路径"参考
 *
 * **不要往这个路径写新数据** —— 写入会绕过分片机制，下次 migration
 * 会再次合并这部分内容（无害但浪费 IO）。
 */
export const AUDIT_LOG_JSONL_PATH = LEGACY_AUDIT_LOG_PATH

/**
 * 启动期初始化（W1.3 / R2 F1+F2）：把旧版 `desktop-audit.jsonl` 流式异步
 * 迁移到当前月份分片，避免首次 `writeAuditLog` 同步全量读写阻塞主进程。
 *
 * 设计契约：
 *   - 必须由 `startup-services.ts` 在 `app.whenReady()` 之后调用一次
 *   - fire-and-forget 即可——返回的 promise 不需要 await，writeAuditLog
 *     在 migration 还在跑的时候可以正常写入当前月份分片（migration 写入
 *     通过 sentinel 文件隔离，目标文件 append 模式天然安全）
 *   - 失败 best-effort，永不抛
 *   - 多次调用幂等（migrationDone flag 守卫）
 */
export async function initDesktopAuditLogger(): Promise<void> {
  await migrateLegacyIfNeeded()
}

/**
 * 审计日志归档目录路径（测试 / 外部消费方引用）。
 *
 * 超过 6 月保留窗口的 `desktop-audit-YYYY-MM.jsonl` 会被 rename 到这里，
 * 既不丢合规审计历史，也不让活跃目录无限增长。
 *
 * **二次保留窗口未实现（已知遗留，登记到 harness）**：本目录目前不做
 * 二次清理 / 物理删除——合规审计性质（`data` 类）默认走"永久保留"。
 * 重度桌面操控用户长期可能积累 N GB，需要在 Wave 2 / Wave 3 由
 * `storage-manager` UI 暴露主动清理 / 导出入口（参考 RFC §五 4.3 "高级"
 * 标签下的"清空所有数据"或"我的资产 → 桌面操控审计"）。如本期内出现
 * 用户反馈则单独 hotfix 加一个 12 月二次窗口。
 */
export const AUDIT_LOG_ARCHIVE_DIR = ARCHIVE_DIR

/**
 * 为测试暴露的内部状态重置工具——重置 `auditDirEnsured` / `migrationDone`
 * / `lastCleanupMonth` 让下次调用重新触发 mkdir / migration / cleanup。
 *
 * **仅限测试使用**，生产代码不应调用。
 */
export function __resetAuditDirEnsuredForTest(): void {
  auditDirEnsured = false
  migrationDone = false
  lastCleanupMonth = null
}
