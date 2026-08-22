/**
 * fs-watch 启动失败的轻量 telemetry。
 *
 * 抽出动机：useFolderWatch 把 watch 启动失败设计成 fail-soft（不弹 toast、
 * 不打扰用户），但 dogfood 期遇到外接盘 unmount / 跨 Space 路径未 hydrate /
 * path-access-checker 拒绝时，用户看到的现象就是"侧边栏不更新"——和真正的
 * main 端 dispatch bug 长得一模一样，开发者无从分辨。
 *
 * 这个 helper 只做一件事：在内存里记下"哪条路径 watch 失败了 + 为什么"，
 * 通过 `window.__TABTIN_FS_WATCH_TELEMETRY__` 暴露给 dogfood 期排查。
 *
 * 设计取向：
 * - 不上报后端，不持久化——dogfood 阶段开发者自己看 console / window 快照即可
 * - 5 分钟内同 (rootPath, errorCode) 不重复上报，避免 unmount 后 hook 反复
 *   启动失败时把 buffer 灌满
 * - rootPath 脱敏，避免在 window 全局对象上留真实用户名
 *
 * 对应的更"重"的方案是接到 backend telemetry，但当前阶段这个 helper 已经
 * 足够区分"main 端 dispatch bug 又回来了"和"watch 没起来"两种现象。
 */

export interface FsWatchTelemetryEvent {
  id: string
  eventName: 'fs_watch_setup_failed'
  /** 脱敏后的 rootPath（去掉用户名段） */
  rootPath: string
  /** main 端 / IPC 返回的原始 error 字符串（可能含真实路径，开发期 console 能看到） */
  error: string
  /** 从 error 文案里抽出来的归类 reason code */
  errorCode: FsWatchErrorCode
  /** 'result_failed' = .then 拿到 success:false；'thrown' = .catch 兜到的异常 */
  source: 'result_failed' | 'thrown'
  timestamp: number
}

export type FsWatchErrorCode =
  | 'access_denied'
  | 'outside_workspace'
  | 'not_a_directory'
  | 'path_not_found'
  | 'preload_unavailable'
  | 'thrown_exception'
  | 'unknown'

const MAX_EVENTS = 200
const DEDUP_WINDOW_MS = 5 * 60 * 1000

const events: FsWatchTelemetryEvent[] = []
const counters = new Map<string, number>()
/** 上一次上报时间戳（key = `${errorCode}|${rootPath}`，值 = ms） */
const lastReportedAt = new Map<string, number>()

const nextId = (): string =>
  `fs-watch-telem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const persistToWindow = (): void => {
  if (typeof window === 'undefined') return
  window.__TABTIN_FS_WATCH_TELEMETRY__ = {
    events: [...events],
    counters: Object.fromEntries(counters.entries()),
  }
}

/**
 * 把 macOS / Windows 路径里的用户名段替换成 `<redacted>`，避免 dogfood 报告
 * 时把真实用户名贴出来。
 *
 * 不脱敏路径其余部分——`/dev/proj` 这种相对位置对排查 path-access-checker
 * 行为有用。
 */
export const redactRootPath = (rootPath: string): string => {
  if (!rootPath) return rootPath
  return rootPath
    .replace(/^(\/Users\/)[^/]+/, '$1<redacted>')
    .replace(/^(\/home\/)[^/]+/, '$1<redacted>')
    .replace(/^([A-Za-z]:[\\/]Users[\\/])[^\\/]+/i, '$1<redacted>')
}

/**
 * 从 error 文案里抽 reason code。匹配规则按 main 端
 * `path-access-checker` / `fs:watch` 实际 error 文案归类。匹配不上归
 * `unknown`——上报 raw error 字段足够开发期排查。
 */
export const classifyFsWatchError = (
  rawError: string | null | undefined,
  source: FsWatchTelemetryEvent['source'],
): FsWatchErrorCode => {
  if (source === 'thrown') return 'thrown_exception'
  if (!rawError) return 'unknown'
  const e = rawError.toLowerCase()
  if (e.includes('preload') || e.includes('not available') || e.includes('unavailable')) {
    return 'preload_unavailable'
  }
  if (e.includes('outside workspace') || e.includes('outside')) return 'outside_workspace'
  if (e.includes('access denied') || e.includes('permission') || e.includes('eacces')) {
    return 'access_denied'
  }
  if (e.includes('not a directory') || e.includes('enotdir')) return 'not_a_directory'
  if (e.includes('not found') || e.includes('enoent') || e.includes('does not exist')) {
    return 'path_not_found'
  }
  return 'unknown'
}

export interface ReportFsWatchSetupFailedInput {
  rootPath: string
  error: unknown
  source: FsWatchTelemetryEvent['source']
  /** 测试或调试时注入固定时间戳；生产路径走 Date.now() */
  now?: number
}

/**
 * 上报一次 watch 启动失败。返回 true 表示真上报了，false 表示落入 5 分钟
 * 去重窗口被跳过（测试断言用得到）。
 */
export const reportFsWatchSetupFailed = (
  input: ReportFsWatchSetupFailedInput,
): boolean => {
  const now = input.now ?? Date.now()
  const errorMessage =
    input.error instanceof Error
      ? input.error.message
      : typeof input.error === 'string'
        ? input.error
        : input.error == null
          ? ''
          : String(input.error)
  const errorCode = classifyFsWatchError(errorMessage, input.source)
  const redactedPath = redactRootPath(input.rootPath)
  const dedupKey = `${errorCode}|${redactedPath}`
  const last = lastReportedAt.get(dedupKey)
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    return false
  }
  lastReportedAt.set(dedupKey, now)

  const event: FsWatchTelemetryEvent = {
    id: nextId(),
    eventName: 'fs_watch_setup_failed',
    rootPath: redactedPath,
    error: errorMessage,
    errorCode,
    source: input.source,
    timestamp: now,
  }

  events.push(event)
  if (events.length > MAX_EVENTS) {
    events.shift()
  }

  const counterKey = `fs_watch_setup_failed.${errorCode}`
  counters.set(counterKey, (counters.get(counterKey) ?? 0) + 1)

  persistToWindow()
  return true
}

export const getFsWatchTelemetrySnapshot = (): {
  events: FsWatchTelemetryEvent[]
  counters: Record<string, number>
} => ({
  events: [...events],
  counters: Object.fromEntries(counters.entries()),
})

export const resetFsWatchTelemetry = (): void => {
  events.splice(0, events.length)
  counters.clear()
  lastReportedAt.clear()
  persistToWindow()
}
