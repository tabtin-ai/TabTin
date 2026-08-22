/**
 * 渲染进程日志环形缓冲收集器
 *
 * 背景：渲染进程（界面层）的 console 日志在生产环境打了就丢——
 * `utils/logger.ts` 在非 dev 下 `log/info/debug` 直接 return，用户也不会
 * 打开 devtools，出问题时研发对界面层几乎是黑盒。本模块在内存里维护一个
 * 环形缓冲，作为「客户端诊断日志导出」的界面层数据源。
 *
 * 两类来源都会进缓冲：
 *   1. 全局 `console.*`——`installConsoleCapture()` 安装包裹，覆盖存量裸
 *      `console.log/error` 调用；
 *   2. 统一 logger——生产环境 `logger.*` 走被静默的 console，改为直接调
 *      `recordLog()`（见 `utils/logger.ts`）。
 *
 * 只在内存里保留最近 N 条，不落盘、不上报；导出诊断包时一次性 `getLogEntries()`。
 * 收集器是「旁路观测」，任何异常都必须吞掉，绝不能反噬业务代码。
 */

export type LogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface LogEntry {
  /** ISO 8601 时间戳 */
  ts: string
  level: LogLevel
  /** 序列化后的单行文本 */
  text: string
}

/** 环形缓冲容量上限；配合单条长度上限，内存占用有确定天花板。 */
const MAX_ENTRIES = 2000
/** 单条日志文本长度上限，防止超大对象/堆栈撑爆内存。 */
const MAX_TEXT_LEN = 4000

const buffer: LogEntry[] = []
let installed = false
// 重入保护：recordLog 内部不得再触发 console（否则包裹后自我递归）。
let recording = false

function serializeArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`
  }
  if (arg === null) return 'null'
  if (arg === undefined) return 'undefined'
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/**
 * 写入一条日志到环形缓冲。logger 生产分支与 console 包裹都汇聚到这里。
 * 任何异常吞掉——收集失败不能影响业务。
 */
export function recordLog(level: LogLevel, args: unknown[]): void {
  if (recording) return
  recording = true
  try {
    const text = args.map(serializeArg).join(' ')
    buffer.push({
      ts: new Date().toISOString(),
      level,
      text: text.length > MAX_TEXT_LEN ? `${text.slice(0, MAX_TEXT_LEN)}…[truncated]` : text,
    })
    if (buffer.length > MAX_ENTRIES) {
      buffer.splice(0, buffer.length - MAX_ENTRIES)
    }
  } catch {
    // 旁路观测：序列化/写入异常一律吞掉
  } finally {
    recording = false
  }
}

/** 返回当前缓冲快照（副本，避免外部修改内部数组）。 */
export function getLogEntries(): LogEntry[] {
  return buffer.slice()
}

/** 把缓冲格式化成人类可读的单行日志文本（导出 renderer.log 用）。 */
export function formatLogEntries(entries: LogEntry[]): string {
  return entries
    .map((e) => `${e.ts} [${e.level.toUpperCase()}] ${e.text}`)
    .join('\n')
}

/** 仅供测试：清空缓冲。 */
export function __clearLogEntries(): void {
  buffer.length = 0
}

const CAPTURED_LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error', 'debug']

/**
 * 幂等安装全局 console 包裹，让所有 `console.*` 调用旁路进环形缓冲。
 * 应在应用启动最早期调用，以捕获尽量多的启动期日志。
 *
 * 与 errorReporter 的 console.error 面包屑包裹可共存（多层包裹都会执行，
 * 顺序无关紧要）。
 */
export function installConsoleCapture(): void {
  if (installed) return
  installed = true
  const c = console as unknown as Record<LogLevel, (...args: unknown[]) => void>
  for (const level of CAPTURED_LEVELS) {
    const original = c[level]
    if (typeof original !== 'function') continue
    c[level] = (...args: unknown[]) => {
      recordLog(level, args)
      original.apply(console, args)
    }
  }
}
