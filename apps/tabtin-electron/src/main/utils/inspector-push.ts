/**
 * Dev IpcInspector — main 进程 push helper（contract W2-ζ）
 *
 * 业务目标：把 main 端的 HTTP 调用记录推到所有 BrowserWindow 的 renderer
 * 进程，让 dev-mode IpcInspector 浮层能看到这些 HTTP 调用（与 W2-α 的
 * IPC 调用统一在同一个 ring buffer + 浮层）。
 *
 * ─── 设计取舍 ────────────────────────────────────────────────────────
 *
 *   - **每个 BrowserWindow 各自收一份**：每个窗口是独立 renderer 进程，
 *     有独立 ring buffer 和独立 inspector 浮层。多窗口场景下每个窗都看
 *     到全部 HTTP 调用记录（开发者通常只开一个主窗）。
 *   - **dev / prod guard**：`process.env.NODE_ENV !== 'production'` 时
 *     才 push；prod build 时 esbuild 把 push 函数体内的工作 dead-code
 *     -eliminate（不影响 import，但 runtime 是 no-op）。
 *   - **失败静默**：BrowserWindow 已 destroy / 还没创建 / send 抛错 都
 *     不应让 api-proxy 主流程崩溃。dev 工具的"差点意思"远好过"出错"。
 *
 * ─── 不做的事 ────────────────────────────────────────────────────────
 *
 *   - **不做跨进程聚合**：daemon / cli-server-core 的 HTTP 调用不在本桥
 *     范围（它们是独立进程，没 BrowserWindow）。Wave 5 audit log 时统
 *     一收口。
 *   - **不做反向 ack**：renderer 不需要回 main 表示收到——dev 工具不需
 *     要可靠送达保证。
 */

import { BrowserWindow } from 'electron'
import { createLogger } from '../logger'

const log = createLogger('IpcInspector')

/** 与 preload/dev-inspector-bridge.ts::IpcCallRecordForInspector 形状一致。
 *
 * 重复定义而不是 import：本文件在 main 进程，preload 文件在 sandbox 进程，
 * 跨进程 import path / type emit 都麻烦；保持手动同步是 dev 工具的
 * 合理代价。**字段变更时三处同步**：
 *   - apps/tabtin-electron/src/renderer/src/dev/ipc-call-buffer.ts::IpcCallRecord
 *   - apps/tabtin-electron/src/preload/dev-inspector-bridge.ts::IpcCallRecordForInspector
 *   - apps/tabtin-electron/src/main/utils/inspector-push.ts::InspectorHttpRecord
 */
export interface InspectorHttpRecord {
  readonly id: string
  readonly source: 'http'
  readonly channel: string  // path + search
  readonly args: unknown    // body parsed
  readonly result?: unknown // response data
  readonly error?: {
    readonly code: string
    readonly message: string
    readonly detail?: unknown
  }
  readonly status: 'ok' | 'error' | 'legacy' | 'pending'
  readonly trace_id?: string
  readonly duration_ms: number
  readonly startedAt: number
  readonly method?: string
  readonly url?: string
  readonly httpStatus?: number
}

const INSPECTOR_HTTP_CHANNEL = 'ipc-inspector:http-call'

let counter = 0

function isInspectorEnabled(): boolean {
  return process.env.NODE_ENV !== 'production'
}

/**
 * 生成一条 inspector record id。`{startedAt}-{counter}` 格式简单且本进程
 * 内可保唯一（counter 单调递增到 max safe int 都不冲突）。
 *
 * 不用 trace_id 当 id：trace 在重试场景下多次 attempt 共用同一个 trace，
 * 但 inspector record 只 push 一条；用 trace 当 id 会跟同 trace 的 IPC
 * record 冲突。
 */
export function makeInspectorRecordId(): string {
  counter += 1
  return `${Date.now().toString(36)}-${counter.toString(36)}`
}

/**
 * Push 一条 HTTP 调用记录到所有 dev BrowserWindow 的 renderer。
 *
 * - prod 模式：no-op
 * - 没有 BrowserWindow（譬如 main 启动期）：no-op，不报错
 * - send 抛错：try/catch 静默吞掉（dev 工具不能让 api-proxy 主流程崩）
 *
 * **副作用边界**：本函数同步调用 webContents.send；webContents.send 是
 * fire-and-forget，不阻塞调用方的 await 链。即使有 100 个窗口，循环耗时
 * 也是微秒级。
 */
export function pushHttpCallToInspector(record: InspectorHttpRecord): void {
  if (!isInspectorEnabled()) return

  let windows: BrowserWindow[] = []
  try {
    windows = BrowserWindow.getAllWindows()
  } catch {
    // app 还未 ready / 已 quit — 静默
    return
  }

  for (const win of windows) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.send(INSPECTOR_HTTP_CHANNEL, record)
    } catch (e) {
      // 单窗口 send 失败不影响其他窗口；不打 warn 以免 dev 终端噪音
      if (process.env.TABTIN_INSPECTOR_DEBUG === '1') {
        log.warn('send to window failed:', e)
      }
    }
  }
}

export const __INSPECTOR_HTTP_CHANNEL_FOR_TESTS = INSPECTOR_HTTP_CHANNEL
