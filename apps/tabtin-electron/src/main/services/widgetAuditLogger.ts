/**
 * widgetAuditLogger — Widget sendPrompt audit log（短期落 main 进程日志文件）。
 *
 * 背景：Widget RFC §四 决策 13（sendPrompt 完整版）承诺 audit log；Wave 7 实施时
 * 把 audit 事件只存在 renderer 进程的**内存 ring buffer**（`widgetSendPromptHandler.ts`
 * 的 `devEvents`，MAX=100）。缺陷：
 *   - 重启丢：用户 app 退出 → 全部清零，出事故后运维 / 开发者没有任何痕迹
 *   - 只 ring buffer：100 条封顶，第 101 条起把前面的挤掉
 *   - 跨端不共享：renderer 内存 / 只在当前窗口
 *
 * 本模块是**短期补丁**（真正的后端 audit 接口留给 Wave 8）：把每次成功触发的
 * sendPrompt 事件 append 到 `~/.tabtin/widget-audit.log`（JSON lines 格式），
 * 让出事故时 `tail -f` 即可看到真实 widget_id / text / timestamp / session_id。
 *
 * **路径选择**：与 `desktop-audit-logger.ts` 字面对齐——都放 `~/.tabtin/`。
 * 原 prompt 提议 `app.getPath('userData')`，但 Electron 会把 userData 放到
 * `~/Library/Application Support/TabTin/logs/`，开发者 `tail` 时不容易找；统一
 * 放 `~/.tabtin/` 让两类 audit 在同一目录下，`ls ~/.tabtin/*.log*` 一眼看到。
 *
 * **rotate 策略**：文件 > 10MB 时把当前文件 mv 到 `widget-audit.log.old`（覆盖旧备份），
 * 下一次 append 创建新的 widget-audit.log。保留 1 份历史备份——不做更复杂的多代轮转
 * 避免给短期补丁写复杂代码（Wave 8 真实 audit 接口落地后本模块整体下线）。
 *
 * **不阻塞契约**（widget RFC §七 风险登记）：
 *   - `writeAuditEntry` 永不抛：写盘失败只在 console.warn，不影响 sendPrompt 业务链路
 *   - renderer 侧 `widgetSendPromptHandler.ts` 以 fire-and-forget 方式调 IPC，不 await
 *     磁盘写回——哪怕磁盘满 / 权限错 / 路径锁死，用户点 widget 也能正常发消息
 */

import { appendFileSync, mkdirSync, renameSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import { createLogger } from '../logger'

const log = createLogger('widgetAuditLogger')

// ── 类型定义 ────────────────────────────────────────────

/**
 * 一条 widget sendPrompt audit entry。schema 与 `WidgetSendPromptDevEvent`
 * 对齐（renderer 内存 ring buffer 也用同字段），新增 `trigger_source`（总是
 * `'widget'`，为 Wave 8 后端接口预留 — 未来可能扩展 `'keyboard_shortcut'` 等）。
 */
export interface WidgetAuditLogEntry {
  timestamp: number
  session_id: string
  widget_id: string
  text: string
  meta?: unknown
  /**
   * 预留字段。本 Wave 总是 `'widget'`；未来扩展到其他触发源（键盘快捷键 /
   * CLI / Lark bot 等）时保持 schema 兼容。
   */
  trigger_source?: 'widget'
}

// ── 常量 + 路径 ──────────────────────────────────────────

/** 日志目录——与 desktop-audit-logger 同源，便于开发者统一 `ls ~/.tabtin/*.log*` 排障。 */
const AUDIT_LOG_DIR = getHomeTabtinPath()
const AUDIT_LOG_FILENAME = 'widget-audit.log'
const AUDIT_LOG_OLD_FILENAME = 'widget-audit.log.old'

/**
 * 文件 rotate 阈值。10MB 是用户感知"日志还能打开用文本工具看"的上限：
 *   - 一条 audit entry 含 text（限 1000 字符）+ meta（限 4KB）最极端约 5KB
 *   - 10MB 约装 2000 条——普通用户 1 周不该有 2000 次 sendPrompt
 *   - 超这阈值说明可能已被恶意 widget 滥用 / bug 刷屏，rotate + 新开文件让
 *     当前 session 的最新事件不被历史淹没
 */
const AUDIT_LOG_ROTATE_BYTES = 10 * 1024 * 1024

// ── 状态 ────────────────────────────────────────────────

let auditDirEnsured = false

// ── 实现 ────────────────────────────────────────────────

/**
 * 返回日志文件绝对路径——测试和外部消费方引用。
 */
export function getWidgetAuditLogPath(): string {
  return join(AUDIT_LOG_DIR, AUDIT_LOG_FILENAME)
}

export function getWidgetAuditLogOldPath(): string {
  return join(AUDIT_LOG_DIR, AUDIT_LOG_OLD_FILENAME)
}

/**
 * 确保日志目录存在（懒初始化避免 startup 时 mkdir；生产体验 99% 用户不触发 widget
 * audit，不必每次启动都 mkdir）。幂等——只在首次 append 时 mkdir 一次。
 */
function ensureAuditDir(): void {
  if (auditDirEnsured) return
  mkdirSync(AUDIT_LOG_DIR, { recursive: true })
  auditDirEnsured = true
}

/**
 * 如果当前文件 > ROTATE 阈值，把它 mv 到 `.old`（覆盖旧备份），让下一次 append
 * 创建新文件。**失败不抛**——rotate 是尽力而为。
 */
function rotateIfNeeded(filePath: string): void {
  try {
    if (!existsSync(filePath)) return
    const stat = statSync(filePath)
    if (stat.size < AUDIT_LOG_ROTATE_BYTES) return
    renameSync(filePath, getWidgetAuditLogOldPath())
  } catch (err) {
    // 尽力而为——rotate 失败不应阻塞 audit 写入
    log.warn('rotate failed:', err)
  }
}

/**
 * 把一条 audit entry 序列化成 JSON line 追加到文件。永不抛——写盘失败只 warn。
 *
 * **fire-and-forget 语义**：调用方（IPC handler）不 await 也不 try/catch，失败
 * 只影响 audit 完整性，不阻塞 sendPrompt 业务链路（renderer 已发完消息）。
 */
export function writeWidgetAuditEntry(entry: WidgetAuditLogEntry): void {
  if (!entry || typeof entry !== 'object') return
  if (!entry.session_id || !entry.widget_id) return

  const record = {
    timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
    session_id: entry.session_id,
    widget_id: entry.widget_id,
    text: typeof entry.text === 'string' ? entry.text : '',
    meta: entry.meta ?? null,
    trigger_source: entry.trigger_source ?? 'widget',
  }

  try {
    ensureAuditDir()
    const filePath = getWidgetAuditLogPath()
    rotateIfNeeded(filePath)
    appendFileSync(filePath, JSON.stringify(record) + '\n', { mode: 0o600 })
  } catch (err) {
    log.warn('append failed:', err)
  }
}

/**
 * 注册 IPC handler：renderer 通过 `tabtin.widgetAudit.append(entry)` 调本 handler
 * 把 audit entry 写到 main 进程管理的日志文件。
 *
 * **幂等**：重复调用不重复注册 handler——`ipcMain.handle` 第二次会抛。本函数
 * 记录 installed flag 防重复。
 *
 * **为什么不用 ipcMain.on（单向）**：renderer 侧写失败需要在 dev mode 能报出——
 * `invoke` 的 Promise 让 renderer 能 try/catch（即便 renderer fire-and-forget
 * 不 await，future Wave 8 前端 dev panel 可以 await 拿错误码）。
 */
let handlerInstalled = false

export function initWidgetAuditLogger(): void {
  if (handlerInstalled) return
  ipcMain.handle('widget-audit:append', async (_event, entry: WidgetAuditLogEntry) => {
    writeWidgetAuditEntry(entry)
    return { ok: true }
  })
  handlerInstalled = true
}

/**
 * 测试专用——重置模块状态（防多 case 污染）。生产代码不调用。
 */
export function __resetWidgetAuditLoggerForTests(): void {
  auditDirEnsured = false
  if (handlerInstalled) {
    try {
      ipcMain.removeHandler('widget-audit:append')
    } catch {
      /* ignore — handler not registered */
    }
    handlerInstalled = false
  }
}
