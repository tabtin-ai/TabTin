/**
 * BrowserOrchestrator —— 契约驱动的 browser action 编排入口（BR-8 WS-A）。
 *
 * 设计正典：`docs/agent/browser-br-8-design.md` §2 目标形态 / §3 WS-A / §4 P1·P3c 行。
 *
 * 这一层把「HTTP action → 引擎调用 → 响应拼装」收成**双端唯一一份**：
 * 响应形状在此定义**一次**，两端各传自己的 `hostHooks`（最后一公里：从各自状态源取数据 /
 * 调各自的执行引擎）。于是默认值 / 字段 / 形状不可能再在两端漂移（BR-1/2/4 那类
 * 「route 双写漂移」的结构性根治）。
 *
 * ⚠️ electron-free、零运行时副作用：本模块只依赖能力矩阵纯投影（`capability-matrix`）
 * + 共享 runtime（`runtime` 的 RefCache 等纯数据结构）+ 调用方注入的 `hostHooks`，
 * **绝不** import electron / playwright / 两端 route。可被 Electron / Daemon / 未来 CLI
 * 校验三方安全引用（与 `capability-matrix.ts` 同一条线）。
 *
 * 已迁范围：
 *  - P1（#128）：自描述命令 `capabilities` / `context`。
 *  - P3c 切片①（#156）：交互命令 `act` / `observe`。
 *  - P3c 切片②（#162）：`snapshot`（含 compact + RefCache）/ `eval`。Electron eval 经
 *    `electronExecutorBridge` 迁移缝由 route 调 `sendExecutorResult`（保留 enhanceErrorResponse）；
 *    Daemon eval 恒 200 直透 `executeScript` 产出。
 *  - P3c 切片③（#173）：`resource.*`（list/probe/inspect/capture/download/smart-download）
 *    + `stream.*`（parse/info/download）。这两族两端实现差异极大、
 *    几乎无可收敛的共享投影，故经**独立注入点 `hostHooks.resourceStream`**、各 action 的 hook
 *    **直接返回 `BrowserActionResult`**（含 Electron `electron-executor` 桥变体），Orchestrator
 *    只承担「单一分发点 + 守卫错误归一」，不前置收敛校验（两端守卫顺序不同，收敛会改边界状态码）。
 *    详见 `BrowserResourceStreamHooks` 注释。
 *  - P3c 切片④（收尾，本期）：`record.*` / `replay.*` / `run.*`。两端录制/回放模型差异极大
 *    （Electron RunSessionManager 逐帧 + 事件流；Daemon RecordingManager 动作脚本），形状无法
 *    在零行为变更下收敛，故经 `session` hooks **忠实复刻各端响应体**（与 `projectActPayload` 的
 *    daemon 直透同模式）；状态码 / 校验错误（缺 runId 400、未找到 404、冲突 409）统一经
 *    `BrowserActionError` 在编排层决策。`run.*` 仅 Electron 提供 hook，Daemon 缺 → 落 `null`
 *    迁移缝（维持现状 404）。
 */

import {
  projectCapabilitiesForRuntime,
  type BrowserRuntime,
  type CapabilityProjection,
} from '../capability-matrix'
import {
  CAPTCHA_REQUIRED_HINT,
  projectCaptchaRequired,
} from '../captcha/CaptchaDetector'
import {
  buildCompactSnapshot,
  formatCompactSnapshot,
  buildRefEntries,
  buildBackendRefEntries,
} from '../snapshot/compact-snapshot'
import { getSharedRefCache, type RefEntry } from '../runtime'
import { effectiveSemanticRole, normalizeSemanticName, semanticKey } from '../runtime/ref-semantic'
import type { BrowserJobManager, BrowserJobProgress } from '../runtime/BrowserJobManager'
import { wrapEvalCode } from './wrapEvalCode'

export { CAPTCHA_REQUIRED_HINT }
import { evaluateBrowserActionPolicy, type BrowserPolicyHostHooks } from './browser-policy'
import {
  BrowserActionError,
  normalizeActRequest,
  type ActCompatibilityWarning,
  type BrowserActionErrorInfo,
} from './act-request'

export { BrowserActionError, type BrowserActionErrorInfo } from './act-request'

// ── 自描述 context 的形状（唯一一份）────────────────────────────────

/** 自描述 context 里的活跃 tab（id/url/title）。两端形状一致。 */
export interface BrowserActiveTab {
  id: string
  url: string | null
  title: string | null
}

/**
 * `context` 命令的「最后一公里」数据——由各端从**自己的状态源**取，经 hostHooks 注入：
 *  - Electron：活跃 tab / tabCount 来自 `CrawlspaceContextHub`；space/crawlspace/workspace 来自 CLI 上下文。
 *  - Daemon：活跃 tab / tabCount 来自 `DaemonBrowserService`；`crawlspaceId` 恒 `null`（headless 无聚合层）。
 *
 * 注意 `runtime` **不在此**——它由 `hostHooks.runtime` 提供，Orchestrator 统一拼到响应头部，
 * 保证「形状定义一次、运行时标识不靠各端手填」。
 */
export interface BrowserContextInfo {
  /** 上下文来源标识（Electron: `'electron'` | `'electron-dev'`；Daemon: `'daemon'`）。 */
  source: string
  spaceId: string | null
  crawlspaceId: string | null
  workspaceRoot: string | null
  activeTab: BrowserActiveTab | null
  tabCount: number
}

/**
 * `context` 命令的**唯一一份响应形状**，对齐 `browser.go` 的 context OutputSchema
 * （runtime / source / spaceId / crawlspaceId / workspaceRoot / activeTab / tabCount）。
 *
 * 字段顺序在 `buildContextResponse` 里固定，**与两端现状逐字段一致**（零行为变更）。
 */
export interface BrowserContextResponse extends BrowserContextInfo {
  runtime: BrowserRuntime
}

// ── 交互命令（act / observe）的「最后一公里」执行原语（P3c）────────────

/**
 * act/observe 引擎执行的**归一结果**：两端把各自引擎产出（Electron 经 ActionExecutor/IPC、
 * Daemon 直连 `BrowserToolImpl`）收敛到这层，供 Orchestrator 统一做响应投影 + 状态判定。
 *
 *  - `success`：是否成功。这同时充当**状态码闸门**——成功 → 200；失败 → 由 Orchestrator
 *    映射成 5xx。两端「成功/失败」语义差异由各自 hook 决定（如 Daemon `act`/`observe`
 *    现状恒 200，故其 hook 恒回 `success: true`、把引擎的 `success:false` 留在 `raw` 里）。
 *  - `raw`：引擎原始产出。Orchestrator 据此投影 wire 响应形状（observe 收敛成单一 3 键形状；
 *    act 现状两端形状不同，见 `projectActPayload` 的迁移缝说明）。
 *  - `errorMessage`：失败时给「成功闸门」端用于 5xx 响应的 message（如 Electron）。
 */
export interface BrowserExecOutcome {
  success: boolean
  raw: Record<string, any>
  errorMessage?: string
}

/** observe 命令解析后的入参（默认值由 Orchestrator 统一填，`limit` 默认走 hook 注入）。 */
export interface BrowserObserveParams {
  selector?: string
  include_som: boolean
  limit: number
}

/**
 * act/observe 的「最后一公里」注入点（差异收敛到一处，而非整条 route 双写）。
 * 仅当 hostHooks 提供本对象时，Orchestrator 才接管 act/observe（否则返回 `null` 迁移缝）。
 */
export interface BrowserExecHooks {
  /**
   * 准备目标 tab（运行时特有）：守卫 + url 处理 + 解析/ensure tab。
   *  - Electron：`resolveTabId(body.tabId, {spaceId, crawlspaceId})`（executor 就绪已在 dispatcher 闸门校验）。
   *  - Daemon：`requireBrowser` / `isBrowserCoreReady` 守卫 + 可选 `ensureTab(body.url)` + 取活跃 tab。
   * 守卫/参数失败请抛 `BrowserActionError`（Orchestrator 捕获 → 错误响应）；其余异常透传
   * （保留 Electron route 现状的「无 try/catch、向上抛」语义）。
   */
  prepareTab(body: any): Promise<string | undefined>

  /** 用**已回解 ref**的 actions 调 act 引擎。 */
  runAct(tabId: string | undefined, resolvedActions: any[], body: any): Promise<BrowserExecOutcome>

  /** 调 observe 引擎（params 已由 Orchestrator 解析并填默认，含经 `observeLimitDefault` 的 limit）。 */
  runObserve(tabId: string | undefined, params: BrowserObserveParams, body: any): Promise<BrowserExecOutcome>

  /** observe `limit` 的默认值（Electron 50 / Daemon 100，保留现状差异、零行为变更）。 */
  observeLimitDefault: number

  /**
   * act 是否拒绝空 actions 数组（Daemon 现状 `length===0` → 400；Electron 现状放行空数组）。
   * 保留两端现状校验差异、零行为变更；缺省 falsy = 放行（Electron 口径）。
   */
  requireNonEmptyActions?: boolean

  /**
   * snapshot 引擎调用（含各端 tab 准备 / Daemon 降级路径）；`params` 已由 Orchestrator 填默认。
   * snapshot **不**走 `prepareTab`（Daemon 在 !browserCoreReady 时诚实降级而非 503）。
   */
  runSnapshot?(body: any, params: BrowserSnapshotRequestParams): Promise<BrowserExecOutcome>

  /**
   * 把 snapshot 内嵌的 base64 截图落盘并返回路径（`include_screenshot` 且未要 base64 时）。
   * 缺省则跳过落盘（与「无 hook」时保留 base64 的语义一致）。
   */
  persistSnapshotScreenshot?(
    base64: string,
    savePath: string | undefined,
    body: any,
  ): Promise<string>

  /** eval 引擎调用；`code` 在 Electron 侧已由 Orchestrator 经 `wrapEvalCode` 处理。 */
  runEval?(tabId: string | undefined, code: string, body: any): Promise<BrowserExecOutcome>
}

/**
 * resource / stream 家族的「最后一公里」（P3c 切片③）。与 `BrowserExecHooks` **解耦**单列一个
 * 注入点，原因有二：
 *  1) 这两族两端实现差异极大（Electron 经 `ActionExecutor` + 渲染进程资源中心；Daemon 经
 *     Playwright/CDP + ResourceTracker + m3u8/mpd 解析器，多个 action 还是 501 诚实降级），
 *     响应形状 / 状态码 / 引擎几乎无可收敛的共享投影——强行收敛会改行为（超出「零行为变更」）；
 *  2) 各端这族 hook 与 act/observe 的执行原语互不依赖：Electron `resources.ts` 只提供这族、
 *     不必为了满足 `BrowserExecHooks` 的 act/observe 必填项而造哑实现（也无需改 `interaction.ts`）。
 *
 * 故每个 action 的 hook **直接返回 `BrowserActionResult`**（而非归一的 `BrowserExecOutcome`）——
 * 这样能忠实复刻各端现状的全部状态码（404/503/403/429/504/501/200-partial）与响应形状，
 * 包括 Electron 经 `sendExecutorResult` 的 `electron-executor` 桥变体（保留 enhanceErrorResponse）。
 * Orchestrator 在这两族只承担「单一分发点 + 守卫错误（BrowserActionError）归一」，
 * 这正是 BR-9 安全拦截 / BR-10 cancel 未来的统一挂点。缺某 hook → 该 action 落 `null` 迁移缝。
 *
 * tabId 解析 / 守卫 / url 校验 / 响应拼装全在各端 hook 内（差异不可约），由各端复用自己的既有原语
 * （Electron `resolveRouteTabId`/`sendExecutorResult`；Daemon `requireBrowser`/`ensureTab`/
 * `classifyStreamError`），抛 `BrowserActionError` 让 Orchestrator 转错误结果。
 */
export interface BrowserResourceStreamHooks {
  runResourceList?(body: any): Promise<BrowserActionResult>
  runResourceProbe?(body: any): Promise<BrowserActionResult>
  runResourceInspect?(body: any): Promise<BrowserActionResult>
  runResourceCapture?(body: any): Promise<BrowserActionResult>
  runResourceDownload?(body: any): Promise<BrowserActionResult>
  runResourceSmartDownload?(body: any): Promise<BrowserActionResult>
  runStreamParse?(body: any): Promise<BrowserActionResult>
  runStreamInfo?(body: any): Promise<BrowserActionResult>
  runStreamDownload?(body: any): Promise<BrowserActionResult>
}

/** snapshot 请求参数（默认值由 Orchestrator 统一解析，双端同一份）。 */
export interface BrowserSnapshotRequestParams {
  include_dom: boolean
  include_screenshot: boolean
  include_accessibility_tree: boolean
  include_raw_html: boolean
  include_clean_html: boolean
  /** 内容类型白名单（browser --include，#3426）：作用于 HTML 内容输出，不碰 a11y 树。 */
  include_content_types?: string[]
  include_som: boolean
  full_page_screenshot: boolean
  screenshot_width?: number
  selector?: string
  limit?: number
}

// ── record / replay / run 的「最后一公里」（P3c 收尾）────────────────

/**
 * `record.*` / `replay.*` / `run.*` 成功响应体。
 *
 * ⚠️ **迁移缝（两端形状不收敛）**：两端录制/回放/run 底层模型根本不同——Electron 走
 * RunSessionManager（逐帧视频 + 事件流 ring buffer）、Daemon 走 RecordingManager（动作脚本 +
 * JSON 落盘），响应字段各异（如 record.stop：Electron `{runId,durationMs,eventCount,videoPath}`
 * vs Daemon `{runId,actionCount,startedAt,endedAt}`）。零行为变更下无法收敛成单一形状，故各端
 * hook **原样返回自己的响应体**（Orchestrator 不投影），与 `projectActPayload` 的 daemon 直透
 * 同模式。后续允许行为变更的切片可在此收敛、删缝。
 */
export type BrowserSessionData = Record<string, unknown>

/**
 * record / replay / run 的「最后一公里」注入点（P3c 收尾）。
 *
 * 模型同 `BrowserExecHooks`：逐能力可选——只接管本端实际提供的命令，缺哪项 → 对应 action 落
 * `null` 迁移缝（route 落回旧逻辑；Daemon 无 `run.*` 即维持现状 404）。
 *
 * 约定：成功 → resolve 本端响应体（Orchestrator 恒包成 `status:200` ok 结果，两端成功路径都是
 * 200）；校验/守卫/未找到等失败 → 抛 `BrowserActionError`（Orchestrator 捕获转错误结果）；其余
 * 非结构化异常**透传**（Electron `run.*` 现状由 route 的 `handleRouteError` 兜底，故 Orchestrator
 * 只接管 BrowserActionError、不吞原始异常）。
 */
export interface BrowserSessionHooks {
  recordStart?(body: any): Promise<BrowserSessionData>
  recordStop?(body: any): Promise<BrowserSessionData>
  recordStatus?(body: any): Promise<BrowserSessionData>
  replayRun?(body: any): Promise<BrowserSessionData>
  replayList?(body: any): Promise<BrowserSessionData>
  runStart?(body: any): Promise<BrowserSessionData>
  runEnd?(body: any): Promise<BrowserSessionData>
  runStatus?(body: any): Promise<BrowserSessionData>
  runList?(body: any): Promise<BrowserSessionData>
}

// ── job（长任务异步 + 取消）的「最后一公里」（BR-10 P2）────────────────

/**
 * 长任务异步执行 + 取消的注入点（BR-10 P2，设计正典 §2.2 / §2.3）。
 *
 * **默认所有长任务仍同步**（保持现状：Agent/脚本假设拿到最终结果，零行为变更）；仅当请求体
 * 显式 `async===true`（或 `wait===false`）**且**本端注入了 `jobs` 钩子时，Orchestrator 才起一个
 * job、立即返回 `202 + jobId`，由 `execute` 在后台跑长任务，调用方经 `job.status` 轮询 / `job.cancel`
 * 中止。
 *
 *  - `manager`：进程级共享的 `BrowserJobManager`（两端各注入 `getSharedBrowserJobManager()`），
 *    承载 job 的创建 / 进度 / 终态 / 取消，并供 `job.status` / `job.cancel` 端点查询与中止。
 *  - `execute`：本端把 `actionId` 派到对应长任务引擎，**必须监听 `ctx.signal.aborted` 主动中止**
 *    （Daemon 把 `ctx.signal` 透进 `downloadStream` / replay step loop；Electron 把 signal 传给
 *    stream downloader / ReplayEngine）。成功 resolve 结果载荷（与同步路径
 *    `ok` 结果的 `data` 同形，落进 `job.result`）；失败 reject（落进 `job.error`）。
 */
export interface BrowserJobHooks {
  manager: BrowserJobManager
  execute(
    actionId: string,
    body: unknown,
    ctx: { jobId: string; signal: AbortSignal; reportProgress: (progress: BrowserJobProgress) => void },
  ): Promise<unknown>
}

// ── 宿主钩子（两端注入差异的「最后一公里」）──────────────────────────

/**
 * 两端注入的宿主钩子：只装「确实不同的那部分」，差异收敛到一个明确的注入点，
 * 而非整条 route 双写。
 *
 * 模型：`runtime` 必填；其余按「能力注入」逐项可选——只接管本端实际提供的命令，缺哪项则
 * 对应 action 落 `null` 迁移缝（与 P1 一脉相承）。
 *  - `runtime`：本端运行时标识——决定 `capabilities` 投影哪一列、`context.runtime` 取值、
 *    `act` 响应投影走哪种形状。
 *  - `getContextInfo()`：本端 `context` 数据来源；可同步可异步（Daemon 需 await 取页面标题）。
 *    缺省 → `context` 落 `null`。
 *  - `exec`：本端 act/observe/snapshot/eval 的执行原语（P3c①②）。缺省 → 这些 action 落 `null`。
 *  - `resourceStream`：本端 resource/stream 家族的执行原语（P3c③）。缺省 → 这些 action 落 `null`。
 *  - `session`：本端 record/replay/run 的执行原语（P3c 收尾④）。逐能力可选，缺哪项 → 对应
 *    action 落 `null`（Daemon 无 `run.*` 即靠此维持现状 404）。
 *  - `jobs`：本端长任务异步执行 + 取消运行时（BR-10 P2）。缺省 → 长任务恒同步、`job.*` 端点落
 *    `null` 迁移缝（见 `BrowserJobHooks`）。
 */
export interface BrowserOrchestratorHostHooks {
  runtime: BrowserRuntime
  getContextInfo?(): BrowserContextInfo | Promise<BrowserContextInfo>
  exec?: BrowserExecHooks
  resourceStream?: BrowserResourceStreamHooks
  session?: BrowserSessionHooks
  /**
   * BR-9 安全策略**处置**钩子（判定在 browser-core 的纯函数 `evaluateBrowserActionPolicy`，
   * 处置在 host）。仅 `confirm` 类动作（contract risk=write）会用到 `resolveConfirmation`：
   *  - Electron：弹 `ApprovalManager.requestApproval`（真人确认 + scope cache 记忆）。
   *  - Daemon：默认放行（headless 无人 UI）+ 记日志——零行为变更（见 daemon 注入处注释）。
   * **缺省（未注入 policy）时 confirm 类动作 fail-closed 被拒**（见 `handleBrowserAction` 闸门）——
   * 所以凡会路由 write 类 action 的 route，其 hostHooks **必须**注入 policy，否则现有可用动作会被 403。
   * `block` 类（受限脚本 / 命令硬红线 / 系统目录落盘）不经 host、由闸门直接拦——安全硬线双端都生效。
   */
  policy?: BrowserPolicyHostHooks
  /**
   * 输出路径**工作区边界**判定的根（绝对路径）。提供后，落盘到根外 → `block`；缺省则跳过边界判定。
   *
   * ⚠️ **P1 两端均不注入**（刻意为之，保零行为变更）：各端既有 save 校验
   * （Electron `sanitizeSavePath` / Daemon `validateSavePath`）的允许集**更宽**——含 `~/.tabtin`、
   * `/tmp`、cwd——而闸门用的 `isPathInAllowedRoots` 会把 `/tmp` 当「过宽路径」过滤掉、且只认 roots
   * 本身。若在此注入更窄的边界，会把现在能落到 `~/.tabtin` / `/tmp` 的截图/下载流程拦成 403（回归）。
   * 故边界判定继续由各端既有 save 校验承担；闸门只保留**系统目录硬红线**（`checkHardlinePath`，与两端
   * 既有校验同语义、零行为变更）。把闸门边界与各端 save 允许集统一收敛留待后续切片。字段先留作管道。
   */
  workspaceRoots?: readonly string[]
  /**
   * BW-5 optional domain allowlist for URL-bearing browser actions. Empty/undefined keeps
   * current behavior. Subresource/WebSocket runtime interception should reuse
   * `evaluateBrowserDomainAllowlist`; this hook only gates actions whose target URL is known
   * before dispatch (`open` / `nav` / explicit download URLs).
   */
  allowedDomains?: readonly string[]
  jobs?: BrowserJobHooks
}

// ── 编排结果（ok / error 判别联合）──────────────────────────────────

/** 错误响应的「决策载荷」：Orchestrator 钦定 code/message/提示，route 用各自 envelope 落地。 */
/**
 * Orchestrator 的处理结果：ok / error 判别联合，携 HTTP 状态码。
 *
 * **wire envelope 仍归各端**：route 拿到结果后，ok 用各自 `okResponse(data)`、error 用各自
 * `errorResponse(code, message, {...})` 包裹再下发——Orchestrator 不碰 envelope（两端 envelope
 * 实现不动，是「零行为变更」的关键），但**状态码 + 错误码 + message + 提示在此唯一决策**
 * （BR-9 安全拦截、BR-10 cancel 后续都挂这里）。
 *
 * `data` 随接入的 action 自然加宽（P1 自描述命令 + P3c act/observe/snapshot/eval payload）。
 *
 * `electronExecutorBridge`：Electron `eval` 专用迁移缝——route 须用 `sendExecutorResult`
 * 落地（含 enhanceErrorResponse），Orchestrator 不碰 HTTP envelope。
 */
export type BrowserActionResult =
  | { ok: true; status: number; data: CapabilityProjection | BrowserContextResponse | Record<string, unknown> }
  | { ok: false; status: number; error: BrowserActionErrorInfo }
  | {
      kind: 'electron-executor'
      executorResult: Record<string, any>
      dataOverride?: unknown
    }

/**
 * 编排层抛出的结构化错误：携状态码 + 错误决策载荷。
 * 由 `hostHooks.exec` 的最后一公里（如 Daemon 的 503 守卫、url 校验 400）抛出，
 * Orchestrator 捕获后转成 `{ ok: false, ... }` 结果。
 */
/**
 * `act` 缺参校验的统一提示。两端现状 message 同（'缺少 actions 数组参数'），suggestions
 * 各异——本期把提示文案收敛成一份（合并两端最有用的提示）。这是**唯一**一处错误提示文案
 * 收敛，不影响任何成功路径 / 成功响应形状。
 */
const ACT_VALIDATION_SUGGESTIONS = [
  '格式: { "actions": [{ "type": "click", "selector": "#btn" }] }',
  '支持的操作: click, fill, scroll, wait, type, keyPress, hover, drag, dblclick, upload, select',
  '使用 tabtin browser act --help 查看示例',
]

// ── 响应投影（形状定义一次）────────────────────────────────────────

/**
 * 把 `runtime` + 各端 `getContextInfo()` 取来的数据拼成**唯一一份** context 响应。
 *
 * 显式逐字段拼装（而非 `{ runtime, ...info }`）是为了**钉死字段顺序**——
 * 与两端现状（runtime→source→spaceId→crawlspaceId→workspaceRoot→activeTab→tabCount）
 * 逐字节对齐，杜绝因 hook 返回顺序不同导致的序列化漂移。
 */
function buildContextResponse(
  runtime: BrowserRuntime,
  info: BrowserContextInfo,
): BrowserContextResponse {
  return {
    runtime,
    source: info.source,
    spaceId: info.spaceId,
    crawlspaceId: info.crawlspaceId,
    workspaceRoot: info.workspaceRoot,
    activeTab: info.activeTab,
    tabCount: info.tabCount,
  }
}

/**
 * 从某个观察元素算出它的 eN 引用：优先用引擎给的 1 基 `index`（observe 输出 `index:i+1`），
 * 兜底用数组下标。`index 1 ↔ ref e1`，与 snapshot --compact 的 eN 命名一致。
 */
function observeRefFor(el: any, arrayIndex: number): string {
  const n = typeof el?.index === 'number' && el.index > 0 ? el.index : arrayIndex + 1
  return `e${n}`
}

/**
 * `observe` 成功响应的**唯一一份**投影：`{hint, observed_elements, page_url, page_title, (som_screenshot_base64?)}`。
 *
 * 这正是 BR-15 已把两端对齐到的 3 键（+ 可选 SoM 截图）形状——收编进 Orchestrator 后**只此一份**，
 * 两端不可能再漂。`som_screenshot_base64` 仅在引擎产出时才带（与两端现状一致）。
 *
 * BR-27：每个元素额外注入 `ref:"eN"`，使 observe 加入 snapshot 已有的 eN/RefCache 引用体系——
 * 随后 `act --ref eN` 即可回解（见 `buildObserveRefEntries` + observe case 的 RefCache 填充）。
 * `index` 字段保留为展示序号（= eN 里的 N）。
 */
/** 全字段观察元素（注入 ref）——RefCache 登记与 `--compact=false` 全量响应都用它。 */
function projectObserveElementsFull(raw: Record<string, any>): any[] {
  const elements = Array.isArray(raw.observed_elements) ? raw.observed_elements : []
  return elements.map((el: any, i: number) => ({
    ...el,
    ref: typeof el?.ref === 'string' && el.ref ? el.ref : observeRefFor(el, i),
  }))
}

/** 轻量观察元素：只留 act/判读必需的关键字段（ref/role/text/href/class/表单语义/bbox）；浅路径仍不带 selector/tag/visible，深路径（`host >>> inner`）保留 selector 供 Agent 落盘判读。 */
function toCompactObserveElement(el: any): Record<string, unknown> {
  const selector = typeof el.selector === 'string' ? el.selector : undefined
  const keepSelector = selector?.includes(' >>> ') ?? false
  return {
    ref: el.ref,
    ...(keepSelector ? { selector } : {}),
    ...(el.role ? { role: el.role } : {}),
    ...(el.text ? { text: el.text } : {}),
    ...(el.href ? { href: el.href } : {}),
    // class 帮 Agent 判读无文本控件（#5376），轻量投影也要带。
    ...(el.class ? { class: el.class } : {}),
    ...(el.control_type ? { control_type: el.control_type } : {}),
    ...(typeof el.option_value === 'string' ? { option_value: el.option_value } : {}),
    ...(typeof el.checked === 'boolean' ? { checked: el.checked } : {}),
    ...(el.bbox ? { bbox: el.bbox } : {}),
  }
}

/**
 * 浏览器观察结果的通用消费契约。放在 data **首键**：大响应落盘后 file_ref 的 preview
 * 只露头部，Agent 必须在第一眼知道元素清单和后续动作分别从哪里取。
 */
export const OBSERVE_RESULT_HINT =
  '浏览器观察结果的可交互元素位于 observed_elements；元素的 ref 可传给 browser act，'
  + 'href 只能使用页面返回的原始链接。'
  + '先用本次清单里的 ref 继续 act；要用的目标不在清单里时再 glance 一次补观察（--tree/--screenshot 也走 glance）。'
  + '读正文用 tabtin browser print --save <path> 或 tabtin fetch，不要靠 glance 抠正文。'

/**
 * 清单里存在「带 text 但无 href」的可点条目（hover 导航 / JS 绑定点击的 div/span）时
 * 给 Agent 的用法提示。与 OBSERVE_RESULT_HINT 合并后仍放在 data 首键。
 */
export const OBSERVE_NO_HREF_HINT =
  '清单中带 text 但无 href 的条目（hover 导航/JS 绑定点击）同样可点：'
  + `tabtin browser act --actions '[{"type":"click","ref":"<eN>"}]'（eN 取该条目的 ref）。`
  + '缺 href 不构成拼 URL 或换替代链接的理由。'

/** 是否存在「带 text 但无 href」的可点条目（触发 OBSERVE_NO_HREF_HINT）。 */
function hasTextOnlyElement(elements: any[]): boolean {
  return elements.some((el) => el?.text && !el?.href)
}

/**
 * 登录墙拦截提示（确定性信号 `login_required` 的 hint）。放在 data 首键，保证大响应落盘后
 * file_ref 的头部 preview 也露出——Agent 第一眼就能看到「该停下来让用户登录」，不必再靠
 * 解析元素文本自行推断（背景：BlockDetector 的 auth_wall 探测把「200 页面 + 登录浮层」
 * 确定性地标出来，避免登录识别退化成模型逐轮 glance 的偶然判断）。
 */
export const LOGIN_REQUIRED_HINT =
  '检测到登录墙：立即停下并把选择权交给用户，不要静默改用其他来源，更不能拿别处内容冒充本站结果。'
  + '用 ask_user 卡片向用户说明此页需要登录，并让其二选一：'
  + '① 在 TabTin 浏览器当前标签页手动完成登录（手机号验证码 / 扫码 / OAuth 等），登录后复用同一 --tab-id 继续在本站获取；'
  + '② 明确同意后改从其他公开来源获取（须诚实标注真实来源、不得标为本站结果）。'
  + '不要代填账号 / 密码 / 验证码，不要改用 print --url（会丢登录态）。'

/**
 * 从引擎 observe 结果里提取登录墙信号，投影成确定性的 `login_required`。
 * 命中条件：BlockDetector 判定 `type: 'auth_wall'` 或 `loginRequired: true`。
 * 未命中返回 undefined（不加该键，零行为变更）。
 */
function buildLoginRequired(
  raw: Record<string, any>,
  tabId?: string,
): { reason: string; hint: string; tab_id?: string } | undefined {
  const block = raw?.block
  if (!block || (block.type !== 'auth_wall' && !block.loginRequired)) return undefined
  const reason = typeof block.reason === 'string' && block.reason ? block.reason : '页面需要登录'
  return { reason, hint: LOGIN_REQUIRED_HINT, ...(tabId ? { tab_id: tabId } : {}) }
}

/**
 * 从引擎结果里的 CaptchaInfo 投影确定性 `captcha_required`（对齐 login_required）。
 * 命中：`captcha.detected === true`。
 */
function buildCaptchaRequired(
  raw: Record<string, any>,
): ReturnType<typeof projectCaptchaRequired> {
  return projectCaptchaRequired(raw?.captcha)
}

/** 墙信号置最前，避免 compact / 截断 preview 丢掉。 */
function withCaptchaRequired(
  data: Record<string, unknown>,
  raw: Record<string, any>,
): Record<string, unknown> {
  const captchaRequired = buildCaptchaRequired(raw)
  if (!captchaRequired) return data
  return { captcha_required: captchaRequired, ...data }
}

/**
 * `observe` 成功响应投影 + RefCache 源。命令族统一 `--compact`（#2440）：
 * 轻量（默认，`compact !== false`）每元素只给 ref/role/text/href；深路径 selector（` >>> `）也保留；
 * 仅 `--compact=false` 给全字段（含 selector/tag/visible）。
 * RefCache 始终按全字段登记（需 selector 回解），故返回 `fullElements` 供调用方登记。
 */
function projectObservePayload(
  raw: Record<string, any>,
  compact: boolean,
  tabId?: string,
): { data: Record<string, unknown>; fullElements: any[] } {
  const fullElements = projectObserveElementsFull(raw)
  const observed_elements = compact ? fullElements.map(toCompactObserveElement) : fullElements
  const loginRequired = buildLoginRequired(raw, tabId)
  const captchaRequired = buildCaptchaRequired(raw)
  const data: Record<string, unknown> = {
    // 墙类强结论置最前：截断 preview 里第一眼可见（登录优先于验证码）。
    ...(loginRequired ? { login_required: loginRequired } : {}),
    ...(captchaRequired ? { captcha_required: captchaRequired } : {}),
    hint: [
      OBSERVE_RESULT_HINT,
      ...(hasTextOnlyElement(fullElements) ? [OBSERVE_NO_HREF_HINT] : []),
    ].join(' '),
    observed_elements,
    page_url: raw.page_url,
    page_title: raw.page_title,
  }
  if (raw.som_screenshot_base64) data.som_screenshot_base64 = raw.som_screenshot_base64
  return { data, fullElements }
}

/**
 * 从已投影（带 `ref` + `selector`）的观察元素构建 RefCache 条目，供 observe case 整表替换写入。
 *
 * 每个元素登记两个键 → 同一 selector：
 *  - canonical `eN`（与 snapshot --compact 同一套，文档口径）；
 *  - 防御性裸序号 `"N"`——直接吸收 BR-27 dogfood 里 `ref:"1"` 的写法，避免 Agent 把
 *    `index` 当 ref 时再次落空（非 canonical，仅兜底）。
 * 无 selector 的元素跳过（无法回解）。
 */
function buildObserveRefEntries(observedElements: unknown): Array<[string, RefEntry]> {
  if (!Array.isArray(observedElements)) return []
  const entries: Array<[string, RefEntry]> = []
  const ts = Date.now()
  const nthCounts = new Map<string, number>()
  for (const el of observedElements) {
    const selector = (el as any)?.selector
    if (typeof selector !== 'string' || !selector) continue
    const tag = typeof (el as any)?.tag === 'string' ? (el as any).tag : 'generic'
    const role = effectiveSemanticRole(
      typeof (el as any)?.role === 'string' ? (el as any).role : undefined,
      tag,
    )
    const rawName = typeof (el as any)?.name === 'string'
      ? (el as any).name
      : typeof (el as any)?.text === 'string'
        ? (el as any).text
        : ''
    const name = normalizeSemanticName(rawName)
    const key = semanticKey(role, name)
    const nth = nthCounts.get(key) ?? 0
    nthCounts.set(key, nth + 1)
    const entry: RefEntry = {
      selector,
      timestamp: ts,
      semantic: { role, name, nth },
      ...(typeof (el as any)?.frameId === 'string' && (el as any).frameId
        ? { frameId: (el as any).frameId }
        : {}),
    }
    const ref = (el as any)?.ref
    if (typeof ref === 'string' && ref) {
      entries.push([ref, entry])
      // 裸序号别名：ref="e3" → 同时登记 "3"。
      const bare = ref.startsWith('e') ? ref.slice(1) : ref
      if (bare && bare !== ref) entries.push([bare, entry])
    }
  }
  return entries
}

/**
 * `act` 成功响应的投影。
 *
 * ⚠️ **迁移缝（尚未收敛的两端形状差异）**：act 的成功响应形状两端现状**不同**——
 *  - Electron：只取 `{executed_actions, page_url, page_title, snapshot, diff, (loop_warning?)}`（executor 结果可能更宽，route 主动收窄）。
 *  - Daemon：直透引擎全量 `ExecuteActOutput`（含 `success` / `frontend_execution_time_ms` / `block` / `captcha` 等）。
 *
 * 把两端收敛成同一形状会**改变行为**（Daemon 要么丢掉 block/captcha 等信号、要么 Electron
 * 平添字段），超出本「零行为变更」切片。故这里**忠实复刻两端现状**，把差异集中到这一个
 * 可见、被单测钉住的点——后续允许行为变更的切片只需在此收敛单一形状、删掉这道缝。
 */
function projectActPayload(runtime: BrowserRuntime, raw: Record<string, any>): Record<string, unknown> {
  // Daemon 现状：直透引擎全量产出（已含 captcha 等）。
  if (runtime !== 'electron') return raw

  // Electron：在原收窄字段上补投 captcha_required（与 observe 同契约），
  // 避免验证码信号被丢掉导致 Agent 只看到超时/空成功。
  const captchaRequired = buildCaptchaRequired(raw)
  const out: Record<string, unknown> = {
    ...(captchaRequired ? { captcha_required: captchaRequired } : {}),
    executed_actions: raw.executed_actions,
    page_url: raw.page_url,
    page_title: raw.page_title,
    snapshot: raw.snapshot,
    diff: raw.diff,
  }
  if (raw.loop_warning) out.loop_warning = raw.loop_warning
  // act 内嵌观察（#5376 同款 compact 字段 + observe_status）：引擎有则透传，无则不加。
  if (raw.observed_elements !== undefined) out.observed_elements = raw.observed_elements
  if (raw.observe_status !== undefined) out.observe_status = raw.observe_status
  if (raw.hint !== undefined) out.hint = raw.hint
  if (raw.login_required !== undefined) out.login_required = raw.login_required
  return out
}

/** 从引擎产出取出 snapshot 子对象（Electron 可能把树放在 data 根上）。 */
function extractSnapshotBlob(raw: Record<string, any>): Record<string, any> | undefined {
  const data = raw.data ?? raw
  if (!data || typeof data !== 'object') return undefined
  return (data.snapshot as Record<string, any>) ?? data
}

/**
 * 把 `--include` 原始值切成小写 token 数组（不做单复数/别名规范化——那步交给 htmlCleaner 桥接层
 * 的 parseContentTypeWhitelist）。缺省返回 `[]` = 剥离全部可过滤类型（CLI snapshot 默认口径）。
 */
function parseIncludeContentTypesRaw(raw: any): string[] {
  if (raw == null) return []
  const parts = Array.isArray(raw) ? raw : String(raw).split(',')
  return parts.map((p) => String(p).trim().toLowerCase()).filter(Boolean)
}

/** 解析 snapshot 入参默认值（双端同一份；`compact` 时默认 `include_dom=false`）。 */
function parseSnapshotRequestParams(body: any): { compact: boolean; params: BrowserSnapshotRequestParams } {
  const compact = body?.compact === true
  return {
    compact,
    params: {
      include_dom: body?.include_dom ?? body?.includeDom ?? !compact,
      include_screenshot: body?.include_screenshot ?? body?.includeScreenshot ?? false,
      include_accessibility_tree: true,
      include_raw_html: body?.include_raw_html ?? body?.raw_html ?? body?.rawHtml ?? false,
      include_clean_html: body?.include_clean_html ?? body?.clean_html ?? body?.cleanHtml ?? false,
      // 内容类型白名单（#3426）：CLI snapshot 是本编排的唯一入口，恒设该字段（不传 --include → []
      // = 剥离全部可过滤类型）；内部 requestSnapshot 调用方不经此路径、字段保持 undefined 不过滤。
      // 规范化（单复数 / 别名）由 htmlCleaner 桥接层的 parseContentTypeWhitelist 统一完成。
      include_content_types: parseIncludeContentTypesRaw(body?.include),
      include_som: body?.include_som ?? body?.includeSom ?? false,
      full_page_screenshot: body?.full_page ?? body?.fullPage ?? false,
      screenshot_width: body?.width ?? body?.screenshot_width,
      selector: body?.selector,
      limit: body?.limit,
    },
  }
}

/**
 * compact 分支：格式化 + RefCache replace + 响应 `{compact, elementCount, screenshot_path?}`。
 * 失败返回 `null`，由调用方回退完整快照（与两端现状一致）。
 */
/**
 * 全量 / 回退 snapshot 后，把 a11y 树的 {bN} 句柄登记进 RefCache（指向精确 xpath），
 * 使 `act --ref bN` 可用。不改动返回给 Agent 的响应体，纯副作用登记。解析失败静默跳过。
 */
function registerBackendRefsFromSnapshot(snap: Record<string, any>, cacheTabId: string): void {
  try {
    const ariaTree = snap?.accessibility_tree || ''
    const xpathMap = snap?.xpath_map || {}
    if (!ariaTree || Object.keys(xpathMap).length === 0) return
    const compactSnap = buildCompactSnapshot(snap?.url || '', snap?.title || '', ariaTree, xpathMap)
    const refEntries: Array<[string, RefEntry]> = []
    for (const [ref, entry] of buildBackendRefEntries(compactSnap)) {
      refEntries.push([ref, { ...entry, timestamp: Date.now() }])
    }
    if (refEntries.length > 0) getSharedRefCache().replace(cacheTabId, refEntries)
  } catch {
    // 登记是增强，失败不影响 snapshot 主流程
  }
}

function tryBuildCompactSnapshotResponse(
  snap: Record<string, any>,
  cacheTabId: string,
): Record<string, unknown> | null {
  try {
    const ariaTree = snap?.accessibility_tree || ''
    const xpathMap = snap?.xpath_map || {}
    const pageUrl = snap?.url || ''
    const pageTitle = snap?.title || ''
    const screenshotPath = snap?.screenshot_path

    const compactSnap = buildCompactSnapshot(pageUrl, pageTitle, ariaTree, xpathMap)
    const compactText = formatCompactSnapshot(compactSnap)

    // eN（compact 展示句柄）+ bN（a11y 树行尾句柄）同时登记，指向同一元素同一 xpath——
    // Agent 无论看到 eN 还是 bN 都能 act（一套寻址）。
    const refEntries: Array<[string, RefEntry]> = []
    for (const [ref, entry] of buildRefEntries(compactSnap)) {
      refEntries.push([ref, { ...entry, timestamp: Date.now() }])
    }
    for (const [ref, entry] of buildBackendRefEntries(compactSnap)) {
      refEntries.push([ref, { ...entry, timestamp: Date.now() }])
    }
    getSharedRefCache().replace(cacheTabId, refEntries)

    return {
      compact: compactText,
      elementCount: compactSnap.elements.length,
      ...(screenshotPath ? { screenshot_path: screenshotPath } : {}),
    }
  } catch {
    return null
  }
}

/** eval 缺参校验文案（两端现状 message / suggestions 不同，零行为变更）。 */
function evalMissingExpressionError(runtime: BrowserRuntime): BrowserActionResult {
  if (runtime === 'electron') {
    return {
      ok: false,
      status: 400,
      error: {
        code: 'VALIDATION_ERROR',
        message: '缺少 expression 参数',
        suggestions: ['示例: tabtin browser eval "document.title" --tab auto'],
      },
    }
  }
  return {
    ok: false,
    status: 400,
    error: {
      code: 'VALIDATION_ERROR',
      message: '缺少 expression 或 code 参数',
      suggestions: ['tabtin browser eval "document.title"'],
    },
  }
}

/**
 * resource/stream 家族的统一分发：调本端注入的 hook（缺则 `null` 迁移缝），把 hook 抛出的
 * `BrowserActionError`（守卫 503 / url 校验 400 / 流错误分类等）归一成错误结果，其余异常透传。
 *
 * hook 直接返回 `BrowserActionResult`（这两族无可收敛的共享投影，见 `BrowserExecHooks` 注释）。
 */
async function dispatchResourceStreamHook(
  hook: ((body: any) => Promise<BrowserActionResult>) | undefined,
  body: unknown,
): Promise<BrowserActionResult | null> {
  if (!hook) return null
  try {
    return await hook(body)
  } catch (err) {
    if (err instanceof BrowserActionError) return err.toResult()
    throw err
  }
}

/**
 * record/replay/run 命令的统一分发：缺 hook → `null` 迁移缝；成功 → 200 ok 结果（两端成功路径
 * 都是 200，形状由 hook 原样给）；`BrowserActionError` → 错误结果；其余异常透传（保留 Electron
 * `run.*` 由 route `handleRouteError` 兜底的现状）。
 */
async function dispatchSessionAction(
  fn: ((body: any) => Promise<BrowserSessionData>) | undefined,
  body: unknown,
): Promise<BrowserActionResult | null> {
  if (!fn) return null
  try {
    const data = await fn(body)
    return { ok: true, status: 200, data }
  } catch (err) {
    if (err instanceof BrowserActionError) return err.toResult()
    throw err
  }
}

// ── job（长任务异步 + 取消，BR-10 P2）的分发原语 ──────────────────────

/** 是否请求异步执行（显式 `async===true` 或 `wait===false`）。缺省=同步（零行为变更迁移缝）。 */
function isAsyncRequested(body: unknown): boolean {
  const b = body as { async?: unknown; wait?: unknown } | null | undefined
  return b?.async === true || b?.wait === false
}

/**
 * 长任务异步缝（BR-10 P2，设计 §2.3）：**仅当**本端注入了 `jobs` 钩子**且**请求体要求异步时，
 * 起一个 job 在后台跑、立即返回 `202 + jobId`；否则返回 `null`，调用方回落同步路径
 * （默认行为，零行为变更）。
 *
 * 后台执行经 `jobs.execute`：成功 → `manager.complete`、失败 → `manager.fail`。`manager` 的
 * 终态守卫保证「取消后晚到的 complete/fail」不会覆盖 `cancelled`（见 BrowserJobManager）。
 */
function maybeStartJob(
  actionId: string,
  body: unknown,
  jobs: BrowserJobHooks | undefined,
): BrowserActionResult | null {
  if (!jobs || !isAsyncRequested(body)) return null
  const job = jobs.manager.create(actionId, body)
  void jobs
    .execute(actionId, body, {
      jobId: job.id,
      signal: job.signal,
      reportProgress: (progress) => jobs.manager.reportProgress(job.id, progress),
    })
    .then(
      (result) => jobs.manager.complete(job.id, result),
      (error) => jobs.manager.fail(job.id, error),
    )
  return {
    ok: true,
    status: 202,
    data: {
      jobId: job.id,
      poll: '/browser/job/status',
      pollBody: { jobId: job.id },
    },
  }
}

/** 从请求体取 jobId（兼容 camel/snake/id 三种键，CLI 经 buildRequestBody 会同时下发）。 */
function readJobId(body: unknown): string | undefined {
  const b = body as { jobId?: unknown; job_id?: unknown; id?: unknown } | null | undefined
  const raw = b?.jobId ?? b?.job_id ?? b?.id
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

const JOB_ID_REQUIRED_ERROR: BrowserActionResult = {
  ok: false,
  status: 400,
  error: {
    code: 'VALIDATION_ERROR',
    message: '缺少 jobId 参数',
    suggestions: ['示例: tabtin browser job status --job-id <jobId>'],
  },
}

function jobNotFoundError(jobId: string): BrowserActionResult {
  return {
    ok: false,
    status: 404,
    error: {
      code: 'NOT_FOUND',
      message: `job ${jobId} 不存在`,
      suggestions: [
        '确认 jobId 来自异步任务返回的 202 响应（data.jobId）',
        'job 记录为内存态，进程重启后会丢失',
      ],
    },
  }
}

// ── 编排入口 ────────────────────────────────────────────────────────

/**
 * 契约驱动的 browser action 编排入口。
 *
 * 按 `actionId` 决定如何解析入参 / 执行 / 拼装响应；运行时特有的「最后一公里」（数据来源 /
 * 执行引擎 / 守卫）经 `hostHooks` 注入（两端各传自己的实现）。
 *
 * @param actionId 稳定 action id，对齐能力矩阵 / CLI 命令路径（`capabilities` / `context` / `act` / `observe`）。
 * @param body    请求体（act/observe 从中解析 actions / selector / limit / tabId 等；自描述命令忽略）。
 * @param hostHooks 本端注入的宿主钩子（runtime + context 数据来源 + act/observe 执行原语）。
 * @returns 命中则返回 `BrowserActionResult`；**未被 Orchestrator 接管的 action（或缺 exec hook）返回 `null`**
 *          —— 这是给后续切片「route 通用分发 → 未迁移的 action 落回旧逻辑」预留的迁移缝。
 */
export async function handleBrowserAction(
  actionId: string,
  body: unknown,
  hostHooks: BrowserOrchestratorHostHooks,
): Promise<BrowserActionResult | null> {
  let normalizedBody = body
  let compatibilityWarnings: ActCompatibilityWarning[] = []
  if (actionId === 'act') {
    const normalized = normalizeActRequest(body)
    if (!normalized.ok) return normalized.error.info
    normalizedBody = normalized.body
    compatibilityWarnings = normalized.compatibilityWarnings
  }

  // ── BR-9 统一安全闸门（单一拦截点，**执行前**过闸，不改任何成功响应形状）──────────────
  // 判定在 browser-core（纯函数 `evaluateBrowserActionPolicy`：contract risk + 内容规则），
  // 处置在 host（`hostHooks.policy`）。三态：
  //  - block：受限脚本 / 命令硬红线 / 输出路径系统目录——confirm 也绕不过 → 直接 403 POLICY_BLOCKED。
  //  - confirm：contract risk=write 的写操作——交 host 的 resolveConfirmation 决断；返回 true 继续进
  //    switch；false/undefined（含**未注入 policy** 的 fail-closed）→ 403 APPROVAL_DENIED。
  //  - allow：read 操作直通。
  // 闸门必在 switch 之前；allow / confirm-放行 之后原样进入下方分发，成功路径形状不变。
  const decision = evaluateBrowserActionPolicy(actionId, normalizedBody, {
    expression: (normalizedBody as { expression?: unknown; code?: unknown } | null)?.expression as
      | string
      | undefined,
    workspaceRoots: hostHooks.workspaceRoots,
    allowedDomains: hostHooks.allowedDomains,
  })
  if (decision.action === 'block') {
    return {
      ok: false,
      status: 403,
      error: {
        code: decision.code,
        message: decision.message,
        ...(decision.ruleName ? { detail: { ruleName: decision.ruleName } } : {}),
      },
    }
  }
  if (decision.action === 'confirm') {
    const approved = await hostHooks.policy?.resolveConfirmation?.(decision)
    if (!approved) {
      return {
        ok: false,
        status: 403,
        error: {
          code: 'APPROVAL_DENIED',
          message: '用户拒绝或未确认该浏览器操作',
          detail: { actionType: decision.actionType, reason: decision.reason },
        },
      }
    }
  }

  return dispatchBrowserAction(actionId, normalizedBody, hostHooks, compatibilityWarnings)
}

/**
 * 闸门后的纯分发（内部函数）。glance 等「组合 action」经此内部转发到子管线
 * （observe / snapshot），**不再重复过闸**——闸门只在 handleBrowserAction 入口跑一次，
 * 组合 action 的风险档以对外 action id（glance=read）为准。
 */
async function dispatchBrowserAction(
  actionId: string,
  body: unknown,
  hostHooks: BrowserOrchestratorHostHooks,
  compatibilityWarnings: ActCompatibilityWarning[] = [],
): Promise<BrowserActionResult | null> {
  switch (actionId) {
    case 'capabilities': {
      // 直接用双端共享投影：能力矩阵本就是单一事实源，集中到一处投影、永不漂移。
      return { ok: true, status: 200, data: projectCapabilitiesForRuntime(hostHooks.runtime) }
    }

    case 'context': {
      if (!hostHooks.getContextInfo) return null // 该端未提供 context 数据来源 → 迁移缝。
      const info = await hostHooks.getContextInfo()
      return { ok: true, status: 200, data: buildContextResponse(hostHooks.runtime, info) }
    }

    case 'act': {
      const exec = hostHooks.exec
      if (!exec) return null // 该端未提供执行原语 → 落回旧逻辑（迁移缝）。

      const actions = (body as any)?.actions
      if (!Array.isArray(actions) || (exec.requireNonEmptyActions && actions.length === 0)) {
        return {
          ok: false,
          status: 400,
          error: {
            code: 'VALIDATION_ERROR',
            message: '缺少 actions 数组参数',
            suggestions: ACT_VALIDATION_SUGGESTIONS,
          },
        }
      }

      try {
        const tabId = await exec.prepareTab(body)
        // ref/toRef → selector/toSelector 回解走共享 RefCache（P3a 收编，双端同一份语义）。
        const resolved = getSharedRefCache().resolveRefsInActions<any>(actions, tabId || '__default')
        const outcome = await exec.runAct(tabId, resolved, body)
        if (outcome.success) {
          const data = projectActPayload(hostHooks.runtime, outcome.raw)
          return {
            ok: true,
            status: 200,
            data: compatibilityWarnings.length > 0
              ? { ...data, compatibility_warnings: compatibilityWarnings }
              : data,
          }
        }
        // 失败也要透出验证码墙：否则 click 导航到 sorry 后引擎已标 captcha，
        // Agent 却只看到 INTERNAL_ERROR / CLI 超时叙事，门禁吃不到信号。
        const failedCaptcha = buildCaptchaRequired(outcome.raw || {})
        const failedPageUrl =
          typeof outcome.raw?.page_url === 'string' && outcome.raw.page_url
            ? outcome.raw.page_url
            : typeof outcome.raw?.captcha?.page_url === 'string' && outcome.raw.captcha.page_url
              ? outcome.raw.captcha.page_url
              : undefined
        const failureDetail: Record<string, unknown> = {
          ...(hostHooks.runtime === 'electron' && Array.isArray(outcome.raw?.executed_actions)
            ? { executed_actions: outcome.raw.executed_actions }
            : {}),
          ...(failedPageUrl ? { page_url: failedPageUrl } : {}),
          ...(failedCaptcha ? { captcha_required: failedCaptcha } : {}),
        }
        return {
          ok: false,
          status: 500,
          error: {
            code: 'INTERNAL_ERROR',
            message: outcome.errorMessage || 'Action execution failed',
            ...(Object.keys(failureDetail).length > 0 ? { detail: failureDetail } : {}),
          },
        }
      } catch (err) {
        if (err instanceof BrowserActionError) return err.toResult()
        throw err // 非结构化异常透传（保留 Electron route 现状的向上抛语义）。
      }
    }

    // ── glance：observe + snapshot 的统一入口（命令面重设计）────────────
    // 「看交互」一个动词——观察页面可交互元素、为 act/open 服务（内容导出归 print）。
    // 默认最轻（可交互元素清单 = 原 observe）；
    // `--tree` 全量 a11y 树（= 原 snapshot --compact=false，不带 html）；
    // `--screenshot [--som] [--full-page]` 视觉（= 原 snapshot --include-screenshot /
    // capture / screenshot 的收编）。内部复用 observe / snapshot 两个 case 的全部
    // 管线（RefCache、守卫、投影），只做 flag 翻译，不复制逻辑。
    case 'glance': {
      const wantTree = (body as any)?.tree === true
      const wantSom = (body as any)?.som === true || (body as any)?.include_som === true
      const wantScreenshot = (body as any)?.screenshot === true || wantSom

      if (wantTree || wantScreenshot) {
        const snapshotBody: Record<string, unknown> = {
          ...(body as Record<string, unknown>),
          // tree = 全量树；纯截图模式走 compact（轻量元信息 + 截图落盘）。
          compact: !wantTree,
          include_screenshot: wantScreenshot,
          include_som: wantSom,
          full_page: (body as any)?.full_page ?? (body as any)?.fullPage ?? false,
          // glance 不吐页面 HTML（读内容归 print）。
          include_raw_html: false,
          include_clean_html: false,
          // CLI --save → snapshot 管线的截图落盘键。
          save_path: (body as any)?.save_path ?? (body as any)?.savePath ?? (body as any)?.save,
        }
        return dispatchBrowserAction('snapshot', snapshotBody, hostHooks)
      }

      // 默认最轻：可交互元素清单（ref/role/text/href）。
      return dispatchBrowserAction('observe', body, hostHooks)
    }

    case 'observe': {
      const exec = hostHooks.exec
      if (!exec) return null

      try {
        const tabId = await exec.prepareTab(body)
        const params: BrowserObserveParams = {
          selector: (body as any)?.selector,
          // 兼容 snake_case（CLI）与 camelCase（FC/旧调用方），与两端现状口径一致。
          include_som: (body as any)?.include_som ?? (body as any)?.includeSom ?? false,
          // 默认无上限（#2440）：不传 limit 即返回全部元素（无损）；仅当调用方显式传 limit 才截。
          limit: (body as any)?.limit,
        }
        const outcome = await exec.runObserve(tabId, params, body)
        if (outcome.success) {
          // 命令族统一 --compact（#2440）：默认轻量投影；仅显式 compact=false 给全字段。
          // 缺省必须当 true——否则 CLI/FC 忘传时会吐超长 xpath selector，易撞 64KB 落盘。
          const compact = (body as any)?.compact !== false
          const { data, fullElements } = projectObservePayload(outcome.raw, compact, tabId)
          // BR-27：把 observe 的 eN→selector 沉淀进共享 RefCache（与 snapshot --compact 同一套、
          // 同一分桶口径 `tabId || '__default'`，与 act 回解处 line 一致），使随后 `act --ref eN`
          // 双端一致地回解出 selector。RefCache 始终用全字段（含 selector），不受 compact 影响。
          getSharedRefCache().replace(
            tabId || '__default',
            buildObserveRefEntries(fullElements),
          )
          return { ok: true, status: 200, data }
        }
        return {
          ok: false,
          status: 500,
          error: { code: 'INTERNAL_ERROR', message: outcome.errorMessage || 'Observe failed' },
        }
      } catch (err) {
        if (err instanceof BrowserActionError) return err.toResult()
        throw err
      }
    }

    case 'snapshot': {
      const exec = hostHooks.exec
      if (!exec?.runSnapshot) return null

      const { compact, params } = parseSnapshotRequestParams(body)

      try {
        const outcome = await exec.runSnapshot(body, params)

        // Daemon 诚实降级：{url,title,text,(html?)}，不经 compact / 富快照。
        if (outcome.raw?.degraded) {
          return { ok: true, status: 200, data: outcome.raw.data as Record<string, unknown> }
        }

        if (!outcome.success) {
          return {
            ok: false,
            status: 500,
            error: {
              code: 'INTERNAL_ERROR',
              message:
                outcome.errorMessage ||
                (hostHooks.runtime === 'daemon' ? '快照获取失败' : 'Snapshot failed'),
              retryable: hostHooks.runtime === 'daemon' ? true : undefined,
            },
          }
        }

        const snap = extractSnapshotBlob(outcome.raw)
        const cacheTabId =
          (outcome.raw.crawlTabId as string | undefined) ||
          (body as any)?.tabId ||
          '__default'

        if (
          snap &&
          (body as any)?.include_screenshot &&
          !((body as any)?.include_base64 ?? (body as any)?.base64) &&
          snap.screenshot_base64 &&
          exec.persistSnapshotScreenshot
        ) {
          try {
            snap.screenshot_path = await exec.persistSnapshotScreenshot(
              snap.screenshot_base64,
              (body as any)?.save_path ?? (body as any)?.savePath,
              body,
            )
            delete snap.screenshot_base64
          } catch {
            // 与两端现状一致：落盘失败仅 warn，不阻断快照。
          }
        }

        if (compact && snap) {
          const compactData = tryBuildCompactSnapshotResponse(snap, cacheTabId || '__default')
          if (compactData) {
            // glance --screenshot 等 compact 路径原先丢掉引擎 captcha，门禁永远挂不上。
            return {
              ok: true,
              status: 200,
              data: withCaptchaRequired(compactData, outcome.raw),
            }
          }
          // compact 格式化失败：默认轻量语义下**不静默倒灌全量**（#2440）。仍把 {bN} 句柄
          // 登记进 RefCache（保证后续 act --ref bN 可解），但只回轻量元信息 + 显式全量指引；
          // 要整包 a11y 树，Agent 必须显式 `--compact=false`（无损：全量走显式开关，不丢数据）。
          if (snap) registerBackendRefsFromSnapshot(snap, cacheTabId || '__default')
          return {
            ok: true,
            status: 200,
            data: withCaptchaRequired(
              {
                compact_failed: true,
                title: snap.title ?? null,
                url: snap.url ?? null,
                ...(snap.screenshot_path ? { screenshot_path: snap.screenshot_path } : {}),
                note:
                  'compact 格式化失败，未返回全量 a11y 树以避免灌满上下文。' +
                  '要全量树显式加 --compact=false；或用 observe / extract --schema / eval 精确取数。',
              },
              outcome.raw,
            ),
          }
        }

        // 显式全量（--compact=false）：Electron 回 `result.data`；Daemon 回 `result.data`（含
        // snapshot 子键）。全量 a11y 树在行尾暴露 {bN} 句柄，Agent 会照抄成 act --ref bN——把
        // bN 登记进 RefCache（指向精确 xpath），让「看到什么句柄就能 act」在全量路径也成立。
        if (snap) registerBackendRefsFromSnapshot(snap, cacheTabId || '__default')
        const fullData = (outcome.raw.data ?? outcome.raw) as Record<string, unknown>
        // captcha 在引擎结果根上，不在 data 子树——全量路径也要并入。
        return {
          ok: true,
          status: 200,
          data: withCaptchaRequired(
            fullData && typeof fullData === 'object' ? { ...fullData } : {},
            outcome.raw,
          ),
        }
      } catch (err) {
        if (err instanceof BrowserActionError) return err.toResult()
        throw err
      }
    }

    case 'eval': {
      const exec = hostHooks.exec
      if (!exec?.runEval) return null

      const expression = (body as any)?.expression || (body as any)?.code
      if (!expression) return evalMissingExpressionError(hostHooks.runtime)

      try {
        const codeForEngine =
          hostHooks.runtime === 'electron' ? wrapEvalCode(expression) : expression

        // Daemon 现状：仅 ensureTab + executeScript(body.tabId)，不经 prepareTab 守卫链。
        if (hostHooks.runtime === 'daemon') {
          const outcome = await exec.runEval(undefined, codeForEngine, body)
          return { ok: true, status: 200, data: outcome.raw as Record<string, unknown> }
        }

        const tabId = await exec.prepareTab(body)
        const outcome = await exec.runEval(tabId, codeForEngine, body)
        return {
          kind: 'electron-executor',
          executorResult: outcome.raw,
          dataOverride: outcome.raw?.data ?? outcome.raw?.result,
        }
      } catch (err) {
        if (err instanceof BrowserActionError) return err.toResult()
        throw err
      }
    }

    // ── resource 家族（P3c 切片③）────────────────────────────────────
    // 各端 hook 直接返回 BrowserActionResult（两端形状/状态码差异不可约，忠实复刻）。

    case 'resource.list':
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runResourceList, body)

    case 'resource.probe':
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runResourceProbe, body)

    case 'resource.inspect':
      // 不在此前置校验 resourceId：两端守卫顺序不同（Daemon 先 requireBrowser→503，再查
      // resourceId→400；Electron 先 resourceId→400，再解析 tab），收敛会改边界状态码顺序。
      // 故校验留各端 hook 自持，保零行为变更。
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runResourceInspect, body)

    case 'resource.capture':
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runResourceCapture, body)

    case 'resource.download':
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runResourceDownload, body)

    case 'resource.smart-download': {
      // BR-10 P2：长任务可选异步——`async===true`（或 `wait===false`）且本端接了 jobs 钩子时
      // 返回 202 + jobId；否则回落同步路径（默认，零行为变更）。
      const asyncResult = maybeStartJob(actionId, body, hostHooks.jobs)
      if (asyncResult) return asyncResult
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runResourceSmartDownload, body)
    }

    // ── stream 家族（P3c 切片③）──────────────────────────────────────

    case 'stream.parse':
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runStreamParse, body)

    case 'stream.info':
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runStreamInfo, body)

    case 'stream.download': {
      // BR-10 P2：长任务可选异步（见 resource.smart-download 同款说明）。
      const asyncResult = maybeStartJob(actionId, body, hostHooks.jobs)
      if (asyncResult) return asyncResult
      return dispatchResourceStreamHook(hostHooks.resourceStream?.runStreamDownload, body)
    }

    // ── record / replay / run（P3c 收尾④）────────────────────────────
    // 编排只做「分发 + 状态码/错误决策」，响应体由各端 session hook 原样给（两端模型差异大、
    // 零行为变更下不收敛形状，见 BrowserSessionData 说明）。
    case 'record.start':
      return dispatchSessionAction(hostHooks.session?.recordStart, body)
    case 'record.stop':
      return dispatchSessionAction(hostHooks.session?.recordStop, body)
    case 'record.status':
      return dispatchSessionAction(hostHooks.session?.recordStatus, body)
    case 'replay.run': {
      // BR-10 P3：默认仍同步；显式 async / wait=false 才把 replay.run 纳入可取消 job。
      const asyncResult = maybeStartJob(actionId, body, hostHooks.jobs)
      if (asyncResult) return asyncResult
      return dispatchSessionAction(hostHooks.session?.replayRun, body)
    }
    case 'replay.list':
      return dispatchSessionAction(hostHooks.session?.replayList, body)
    case 'run.start':
      return dispatchSessionAction(hostHooks.session?.runStart, body)
    case 'run.end':
      return dispatchSessionAction(hostHooks.session?.runEnd, body)
    case 'run.status':
      return dispatchSessionAction(hostHooks.session?.runStatus, body)
    case 'run.list':
      return dispatchSessionAction(hostHooks.session?.runList, body)

    // ── job（长任务异步查询 / 取消，BR-10 P2）──────────────────────────
    // 逻辑全在 browser-core：两端 route 只把 /browser/job/* 映射到这两个 action（薄封装）。
    // 缺 jobs 钩子 → `null` 迁移缝（该端未接 job 运行时）。
    case 'job.status': {
      const jobs = hostHooks.jobs
      if (!jobs) return null
      const jobId = readJobId(body)
      if (!jobId) return JOB_ID_REQUIRED_ERROR
      const record = jobs.manager.get(jobId)
      if (!record) return jobNotFoundError(jobId)
      return { ok: true, status: 200, data: { ...record } }
    }
    case 'job.cancel': {
      const jobs = hostHooks.jobs
      if (!jobs) return null
      const jobId = readJobId(body)
      if (!jobId) return JOB_ID_REQUIRED_ERROR
      const record = jobs.manager.get(jobId)
      if (!record) return jobNotFoundError(jobId)
      // cancel() 触发 signal.aborted（引擎据此停循环）+ 标记 cancelled；已终态则返回 false（no-op）。
      const cancelled = jobs.manager.cancel(jobId)
      return {
        ok: true,
        status: 200,
        data: { jobId, cancelled, status: jobs.manager.get(jobId)?.status ?? record.status },
      }
    }

    default:
      // 该 action 尚未由 Orchestrator 接管。返回 null 让调用方落回各端旧逻辑——
      // 后续切片逐条迁移时无需改这里的契约。
      return null
  }
}

/*
 * ── 给后续切片的接口预留说明 ───────────────────────────────────────
 *
 * 1) 入口签名 `handleBrowserAction(actionId, body, hostHooks)` 即终态：后续接入剩余
 *    action 时，只在本文件 switch 加 case，两端 route 仍只「取 hostHooks → 调本入口 →
 *    落地 result」，不再各写业务分支。
 *
 * 2) 三个注入点：`hostHooks.exec`（act/observe/snapshot/eval，hook 返回归一的
 *    `BrowserExecOutcome`、Orchestrator 做投影）、`hostHooks.resourceStream`（resource/stream，
 *    hook 直接返回 `BrowserActionResult`、Orchestrator 只做分发 + 守卫错误归一）、
 *    `hostHooks.session`（record/replay/run，hook 返回 `BrowserSessionData`、Orchestrator 包成
 *    200 ok 结果）。三者解耦：各端只提供自己 route 实际需要的那一组。BR-10 的 job/cancel 可挂在
 *    session hook + 这里的 run.* case 一处（run 完整下沉 runtime 见 §5，本期只下沉了
 *    RecordingRegistry 这一最小首付）。
 *
 * 3) act 响应形状仍有一道 `projectActPayload` 迁移缝（两端现状形状不同）：等允许行为变更的
 *    切片，在那里收敛单一形状、删缝即可——drift 已被集中到一处且单测钉住。
 *
 * 4) `null` 返回值是迁移缝：route 收成「actionId → handleBrowserAction」通用分发后，
 *    未迁移的 action（或缺对应 hook）命中 null → 落回旧逻辑，迁移可逐条灰度、不 big-bang。
 *
 * 5) WS-B 的更多 runtime 状态（latest snapshot / run）后续按 RefCache/NetworkLog 同模式
 *    进入 `runtime`，由 Orchestrator 在执行 action 时读写。
 */
