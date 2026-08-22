/**
 * preload/ipc-shim.ts — IPC 调用统一入口（Wave 2 W2-α / contract 项目）
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  业务目标
 * ═══════════════════════════════════════════════════════════════════════
 *
 * renderer 调任何 IPC 失败时**必须显式失败** + **trace_id 自动可见**。
 * 开发者写新 IPC caller 不需要每次手写 `if (!result.success)` 检查——
 * shim 自动 throw 含 trace_id 的 PlatformIpcError，配合 `withToast` HOC
 * 自动弹 toast 含末 6 位 trace_id。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  为什么不能 import @tabtin/agent-wire
 * ═══════════════════════════════════════════════════════════════════════
 *
 * preload 是 contextBridge 注入到 renderer 的 sandbox 脚本，bundle 体积
 * 直接影响 app 冷启动 / window 创建延迟。一旦 import 了 agent-wire（带
 * `errResponse` / `okResponse` / `ErrorCode` 上千行 + 注释 / 镜像类型），
 * tree-shake 也救不回来——CJS 输出 + electron-vite externalizeDeps 的
 * 组合让符号无法跨 chunk 摇掉。
 *
 * 因此本文件**自包含**：envelope 形态识别、PlatformIpcError 类型、
 * LEGACY_HANDLERS 白名单、ring buffer 全部 inline 实现。这跟
 * `@tabtin/agent-wire/cli-envelope.ts` 的 `CliResponse<T>` 形状必须保持
 * 同步——Wire 端任何 envelope 字段调整请同步本文件的
 * `IpcEnvelope` 类型与 `isEnvelopeShape` 守卫。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  invokeIpc 行为契约（按顺序判断）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * 1. `result = await ipcRenderer.invoke(channel, ...args)` — main 进程
 *    本身 throw（譬如 ipc-lazy 模块加载失败）会被转包成
 *    `PlatformIpcError({ code: 'IPC_REJECT' })` 并 throw。
 *
 * 2. 否则按形态分支：
 *
 *    a. **LEGACY_HANDLERS 白名单内** → 透传 result（caller 自己处理
 *       legacy `{success}` 形状）。这是迁移过渡的"不打挂应用"保护——
 *       当前几乎所有 main 端 handler 仍返 `{success}` 形态，W2-δ / W3
 *       会逐个迁到 envelope，每迁完一个就把 channel 从白名单移除。
 *
 *       **特例（W2-α 自审增强）**：即使 channel 在 LEGACY，如果 main
 *       端返了 envelope 形态且 `ok:false`（典型场景：ipc-lazy 的
 *       LOAD_FAILED / HANDLER_NOT_FOUND 路径会**包装每一个 lazy
 *       channel**返 envelope，无论该 channel happy path 是 envelope 还
 *       是 raw），仍 throw `PlatformIpcError` 并 stamp trace_id。否则
 *       caller 看到 `{ok:false}` 当 legacy 成功路径处理，导致 toast 不
 *       弹、用户看到 undefined 数据——刚好踩 D-3 "失败信号必须显式"
 *       的反模式。「宽进严出」原则。
 *
 *    b. **`{ ok: true, data: ... }` envelope 形态** → return `data`。
 *
 *    c. **`{ ok: false, error: { code, message, detail? } }` envelope** →
 *       throw `PlatformIpcError`，含 `trace_id`（顶层）+ `error.detail`。
 *
 *    d. **既无 `ok` 也不在 LEGACY** → throw `PlatformIpcError({ code:
 *       'LEGACY_SHAPE' })` + console.warn。这条路径表明 main 端 handler
 *       新增了一个非 envelope 形态的 channel 但忘了登记到 LEGACY 或
 *       忘了改 envelope——属于"开发者认知漏洞"，应当立刻暴露而不是
 *       静默接受。
 *
 * 3. 不论命中哪条分支，都向 ring buffer 推一条 `IpcCallRecord`，给
 *    `IpcInspector`（W2-ζ）等观察者订阅。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  Tier 文档（详见 IPC_TIERS.md）
 * ═══════════════════════════════════════════════════════════════════════
 *
 * - **Tier 0**：未登记非 envelope（默认 throw LEGACY_SHAPE）。Wave 7
 *   末应该是空集。
 * - **Tier 1**：白名单 legacy（`LEGACY_HANDLERS` 内常量）。透传 +
 *   ring buffer 标 `status: 'legacy'`。Wave 7 末应该清空。
 * - **Tier 2**：surface envelope（`{ ok, data }` / `{ ok, error }`）。
 *   严格按契约解析，享受自动 trace_id stamp + toast 自动弹出。
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  PlatformIpcError 跨 contextBridge 序列化纪律
 * ═══════════════════════════════════════════════════════════════════════
 *
 * preload 内 throw 的 Error 跨 contextBridge 到 renderer 时，v8 默认只
 * 复制 own enumerable properties（`Error.prototype.message` 默认是
 * `enumerable: false`，会丢）。
 *
 * 本类**显式**用 `Object.defineProperty({ enumerable: true })` 把
 * `name` / `code` / `ipc_channel` / `message` / `trace_id` / `detail`
 * 设为 own enumerable，确保 renderer catch 到的 err 实例上这些字段都
 * 可读——`withToast` HOC 才能拿到 `err.trace_id` 渲染末 6 位、
 * `IpcInspector` 才能拿到 `err.code` 标红。
 *
 * 同时提供 `toJSON()` 让 `JSON.stringify(err)` 输出完整结构，方便
 * audit log / 错误上报序列化。
 */

import { ipcRenderer } from 'electron'
import { notifyIpcCallForInspector } from './dev-inspector-bridge'

// ─── Types ────────────────────────────────────────────────────────────

/**
 * Wire envelope 形态（与 `@tabtin/agent-wire/cli-envelope.ts.CliResponse`
 * 同构，但本文件不能 import）。任何字段变更都要同步那边。
 */
interface IpcEnvelopeOk<T> {
  ok: true
  data: T
  trace_id?: string
  duration_ms?: number
}

interface IpcEnvelopeErr {
  ok: false
  error: {
    code: string
    message: string
    retryable?: boolean
    suggestions?: string[]
    detail?: Record<string, unknown>
  }
  trace_id?: string
  duration_ms?: number
}

type IpcEnvelope<T = unknown> = IpcEnvelopeOk<T> | IpcEnvelopeErr

/**
 * Ring buffer record - one entry per `invokeIpc` call (success / error /
 * legacy passthrough). Subscribed by W2-ζ IpcInspector to render the
 * dev-mode IPC trace overlay.
 *
 * Fields are intentionally JSON-serializable plain values—no Error /
 * Function references—so subscribers can `structuredClone` / send to
 * remote renderer windows without surprises.
 */
export interface IpcCallRecord {
  /** Channel string passed to `ipcRenderer.invoke`. */
  channel: string
  /**
   * `'ok'` — handler returned envelope `{ok:true,data}`, `data` was
   * returned to caller.
   *
   * `'error'` — handler returned envelope `{ok:false,error}` OR
   * main-process threw OR LEGACY_SHAPE detected; caller saw a
   * `PlatformIpcError`.
   *
   * `'legacy'` — channel is in LEGACY_HANDLERS, raw result was passed
   * through to caller without envelope parsing.
   */
  status: 'ok' | 'error' | 'legacy'
  /** Top-level `envelope.trace_id` if present. */
  trace_id?: string
  /** Only set when `status === 'error'`. */
  error_code?: string
  /** Only set when `status === 'error'`. */
  error_message?: string
  /** Wall-clock duration ms (Date.now() based — not perf.now to keep cheap). */
  duration_ms: number
  /** Truncated JSON.stringify of args (max ~200 chars). */
  args_summary: string
  /** Truncated JSON.stringify of returned data (only for ok / legacy). */
  result_summary?: string
  /** `Date.now()` at call start. */
  timestamp: number
}

// ─── PlatformIpcError ─────────────────────────────────────────────────

/**
 * Error thrown by `invokeIpc` for any IPC failure path:
 *
 *   - main-process handler threw → `code: 'IPC_REJECT'`
 *   - envelope `ok:false` → `code: <envelope.error.code>` (e.g. `'UNAUTHORIZED'`)
 *   - non-envelope shape & not in LEGACY_HANDLERS → `code: 'LEGACY_SHAPE'`
 *
 * **Why a custom subclass instead of plain Error**: caller code (especially
 * the `withToast` HOC) needs to branch on `err.code` and access `err.trace_id`
 * without sniffing string messages. Renderer-side check should be:
 *
 * ```ts
 * if (err instanceof PlatformIpcError) { ... }
 * // OR cross-contextBridge friendly:
 * if (err?.name === 'PlatformIpcError') { ... }
 * ```
 *
 * Cross-contextBridge serialization caveat: `instanceof` may not work in
 * renderer because the class identity is on the preload side; use
 * `err?.name === 'PlatformIpcError'` as the cross-process-safe check.
 */
export class PlatformIpcError extends Error {
  readonly code!: string
  readonly ipc_channel!: string
  readonly trace_id?: string
  readonly detail?: unknown

  constructor(opts: {
    code: string
    message: string
    ipc_channel: string
    trace_id?: string
    detail?: unknown
  }) {
    super(opts.message)
    // Force enumerable own properties so contextBridge structured-clone
    // preserves them on the renderer side. Default Error.message is
    // enumerable:false — without this override the `withToast` HOC would
    // see `err.message === undefined` after the cross-process hop.
    Object.defineProperty(this, 'name', {
      value: 'PlatformIpcError',
      enumerable: true,
      writable: false,
      configurable: true,
    })
    Object.defineProperty(this, 'message', {
      value: opts.message,
      enumerable: true,
      writable: false,
      configurable: true,
    })
    Object.defineProperty(this, 'code', {
      value: opts.code,
      enumerable: true,
      writable: false,
      configurable: true,
    })
    Object.defineProperty(this, 'ipc_channel', {
      value: opts.ipc_channel,
      enumerable: true,
      writable: false,
      configurable: true,
    })
    if (opts.trace_id !== undefined) {
      Object.defineProperty(this, 'trace_id', {
        value: opts.trace_id,
        enumerable: true,
        writable: false,
        configurable: true,
      })
    }
    if (opts.detail !== undefined) {
      Object.defineProperty(this, 'detail', {
        value: opts.detail,
        enumerable: true,
        writable: false,
        configurable: true,
      })
    }
  }

  /**
   * Returns a plain JSON-serializable representation. Used by audit log
   * writers and error-reporter pipelines that want the full diagnostic
   * payload (code + trace_id + detail) instead of just `message`.
   */
  toJSON(): {
    name: 'PlatformIpcError'
    code: string
    message: string
    ipc_channel: string
    trace_id?: string
    detail?: unknown
  } {
    const out: ReturnType<PlatformIpcError['toJSON']> = {
      name: 'PlatformIpcError',
      code: this.code,
      message: this.message,
      ipc_channel: this.ipc_channel,
    }
    if (this.trace_id !== undefined) out.trace_id = this.trace_id
    if (this.detail !== undefined) out.detail = this.detail
    return out
  }
}

// ─── LEGACY_HANDLERS whitelist ────────────────────────────────────────

/**
 * Channels whose main-end handler currently returns a non-envelope shape
 * (legacy `{success: bool, ...}`, raw value like `'pong'` / `string` /
 * `number`, or void). `invokeIpc` passes the raw result through to the
 * caller without parsing.
 *
 * **Why this list exists**: As of W2-α (2026-05-03), the vast majority
 * of `apps/tabtin-electron/src/main/**` IPC handlers still return legacy
 * shapes. Forcing strict envelope parsing on Day 1 would break ~250
 * channels overnight. This whitelist captures the current reality so
 * callers see no behavioural change while W2-δ (legacy migration) and
 * W3+ surface framework progress incrementally migrate handlers to
 * envelope.
 *
 * **Lifecycle**:
 *
 *   - W2-δ migrates `tin-bridge:request` / `pty:snapshot-save-sync` /
 *     ipc-lazy throw paths to envelope → those entries removed.
 *   - W3+ surface framework migrates 30 P0 handlers → corresponding
 *     entries removed.
 *   - W7 final pass: this set must be **empty**. If it isn't, the
 *     remaining channels need an explicit "permanent legacy"
 *     justification (extreme cases like sync IPC `pty:snapshot-save-sync`
 *     might warrant a separate `PERMANENT_LEGACY_HANDLERS` set).
 *
 * **How to update**:
 *
 *   - Adding a new channel to preload that doesn't return envelope yet?
 *     → Add it here with a one-line comment explaining the legacy shape
 *     and the planned migration Wave.
 *   - Migrating a handler to envelope on the main side?
 *     → Remove it from here in the same PR. Run `pnpm test` to verify
 *     no caller broke (caller used to expect raw `{success}`, now gets
 *     unwrapped `data` and may need adjustment).
 *
 * **Format**: alphabetical within each module group; module groups
 * ordered by perceived migration priority (high to low). Entries that
 * are sync-IPC or external-process-targeted are marked PERMANENT to
 * signal they may not migrate to envelope at all.
 */
export const LEGACY_HANDLERS: ReadonlySet<string> = new Set<string>([
  // ─── W2-δ explicit scope (must migrate this Wave) ────────────────
  // tin-bridge:request — bare `ipcMain.handle` with custom TinBridgeResponse
  // type, planned migration in W2-δ. Listed here even though preload doesn't
  // currently call it directly (tins agent invokes via dynamic dispatch),
  // so future W2-δ-aware callers see the channel in the registry.
  'tin-bridge:request',
  // pty:snapshot-save-sync — `ipcMain.on` + `event.returnValue` sync path.
  // PERMANENT-ish: synchronous IPC cannot use the same async envelope
  // contract; W2-δ will add a sender guard but the wire shape stays
  // raw. Listed for documentation completeness — `invokeIpc` won't see
  // it (it's a `sendSync`), but the dev-mode inspector should flag any
  // future caller as legacy.
  'pty:snapshot-save-sync',

  // ─── core/startup handlers (ipc-registry.ts) — return raw values ──
  // These return primitives or {success} legacy shape; W2 doesn't
  // migrate them en-masse — W3+ surface framework will retro them when
  // each handler becomes a PlatformSurface declaration.
  'ping',                              // returns string 'pong'
  'app-settings:get',                  // returns {minimizeToTray, autoStart}
  'app-settings:set',                  // returns {success, settings?, error?}
  'system:getHostname',                // returns string
  'system:getLocalNetworkAddresses',   // returns LocalNetworkAddress[]
  'device:getFingerprint',             // returns string
  'get-system-ua',                     // returns string
  'get-app-version',                   // returns string
  'clipboard:writeImage',              // returns {success, error?}
  'get-update-state',                  // returns state object | null
  'get-release-history',               // returns release history items
  'check-for-updates',                 // returns update result object
  'download-update',                   // returns download result object
  'quit-and-install',                  // returns void
  'power:prevent-sleep',               // returns void
  'power:allow-sleep',                 // returns void
  'cli:getCoreCommandCatalog',         // returns CORE_COMMAND_CATALOG object
  'capabilityDiscovery:getSummary',    // returns service summary
  'capabilityDiscovery:refreshExecution', // returns refresh result
  'dialog:showSave',                   // returns string | undefined
  'dialog:showOpen',                   // returns string[] | undefined
  'window:setAppearance',              // returns {success, appearance?, shouldUseDarkColors?, ...}
  'window:getAppearance',              // returns {success, appearance?, shouldUseDarkColors?, ...}
  // W6 批次 1：space:setActive 已迁到 PlatformSurface（surface channel = space:set-active, alias = space:setActive）
  'desktop:setDevicePermissions',      // returns {success: true}
  'desktop:getApprovalStatus',         // returns DesktopApprovalStatus object
  'desktop:revokeApproval',            // returns {success, error?}
  // ：卸载清理返回域内 WipeResult `{ok, removed, failed, skippedProtected}`，
  // 其中 `ok` 表示磁盘清理是否全部成功，不是 wire envelope。未进白名单时
  // invokeIpc 会抛 LEGACY_SHAPE——主进程其实已 clearAuthData，UI 却 toast「操作失败」，
  // 随后因凭证已空回到登录页（假失败）。
  'desktop:wipe-credentials',          // returns WipeResult domain object
  'desktop:wipe-local-data',           // returns WipeResult domain object
  'desktop:uninstall-app',             // returns {ok, credentials, localData, willExit}
  'desktop:list-cleanup-paths',        // returns {credentials, configAndCache, fullWipe}
  'slideshow:enterFullscreen',         // returns {success, error?}
  'slideshow:exitFullscreen',          // returns {success, error?}
  'screenshot:readFileAsDataURL',      // returns string data URL
  // skill:install / skill:uninstall / skill:read-content
  // → W6 批次 2 迁到 PlatformSurface（envelope 形态），从 LEGACY 移除
  'skill:install-npm',                 // returns {success, data?} / {success:false, error} — 面板从 npm 安装
  'shell:openExternal',                // returns {success, error?}
  'shell:openPath',                    // returns {success, error?}
  'shell:showItemInFolder',            // returns {success, error?}
  'clipboard:writeFile',               // returns {success, error?}

  // ─── overlay view  — fire-and-forget，返回 {success} ────────
  // toast / 全局模态 / scrim 控制，caller 不消费返回值（main 端已执行）。
  'overlay:push',                      // returns {success: true}
  'overlay:focus',                     // returns {success, error?}
  'overlay:set-modal-source-open',     // returns {success, error?} — 通用 modal source 显隐
  'overlay:set-hint-size',             // returns {success, error?} — 提示型浮层上报卡片尺寸
  'overlay:set-toast-ignore-mouse-events', // returns {success, error?} — toast 命中区动态穿透
  'overlay:get-toast-cursor-client-point', // returns {success, data?: {clientX, clientY}} — toast 静止指针命中
  'overlay:set-toast-stack-size', // returns {success, error?} — toast 贴卡片收窗
  'overlay:set-toast-content-visible', // returns {success, error?} — Windows 空 toast 隐藏

  // ─── api-proxy ────────────────────────────────────────────────────
  // api:request 已迁出 LEGACY（contract W7 收敛）：main 端在 api-proxy.ts
  // 把 HTTP 响应对象 wrap 成 okResponse(...) 返回，invokeIpc 在 ok:true
  // 分支自动 unwrap 为 data，caller（electronFetch / services/api 等）
  // 拿到的还是 `{status, data, headers, ...}` HTTP 壳。收益：IPC Inspector
  // 标 Tier 2、所有 HTTP 请求的失败信号自动可见。

  // ─── auth handlers (ipc-registry.ts via guardedHandle) ────────────
  // All return {success: bool, ...} legacy. W3+ surface framework will
  // migrate (auth/* surfaces are P0 in W6 list).
  'auth:check',
  'auth:clear',
  'auth:clearTokens',
  'auth:clearUserInfo',
  'auth:get',
  'auth:getAccessToken',
  'auth:getUserInfo',
  'auth:isTokenExpiringSoon',
  'auth:refreshAccessToken',
  'auth:save',
  'auth:saveAccessToken',
  'auth:saveRefreshToken',
  'auth:saveUserInfo',

  // ─── organization handlers ────────────────────────────────────────────
  'organization:getLocalConfig',           // {success, config?, error?}
  'organization:saveLocalConfig',          // {success, error?}
  'organization:clearLocalCache',          // {success, error?}

  // ─── file-system handlers (ipc-lazy module) ───────────────────────
  // All return {success: bool, ...} legacy. Heavy-traffic — W3 surface
  // framework migration high priority.
  'fs:computeSkillContentHash',
  'fs:createDir',
  'fs:deleteDir',
  'fs:deleteFile',
  'fs:ensureSpaceSandbox',
  'fs:ensureDefaultAgentDir',
  'fs:lookupSpaceSandbox',
  'fs:pathExists',
  'fs:readBinaryFile',
  'fs:readDir',
  'fs:readFilePreview',
  'fs:renderOfficePreview',
  'fs:renderOfficePreviewData',
  'fs:rename',
  'fs:ripgrepSearch',
  'fs:ripgrepSearchCancel',
  'fs:replaceInFiles',
  'fs:unwatch',
  'fs:watch',
  'fs:writeBinaryFile',
  'fs:writeFile',

  // ─── git handlers (git-ipc.ts) ────────────────────────────────────
  // All return {success/ok: bool, data?, error?} mixed legacy.
  'git:branch',
  'git:branches',
  'git:branchMeta',
  'git:checkout',
  'git:commit',
  'git:commitDetail',
  'git:createPullRequest',
  'git:diffStat',
  'git:discardFiles',
  'git:fetch',
  'git:fullStatus',
  'git:isRepo',
  'git:log',
  'git:pull',
  'git:pullRequestUrl',
  'git:push',
  'git:rawDiff',
  'git:remotes',
  'git:showAtCommit',
  'git:showFile',
  'git:showStaged',
  'git:stage',
  'git:stash',
  'git:status',
  'git:unstage',
  'git:worktreeCreate',
  'git:worktreeMerge',
  'git:worktreeRemovePreflight',
  'git:worktreeRemove',
  'git:worktrees',

  // ─── agent / agent-engine / agent-security handlers ───────────────
  // Engine-side QueryRequest/Response objects use their own protocol;
  // not envelope. agent-security 3 channels (workspace-snapshot /
  // build-approval-key / build-scope-description) are P0 in W6
  // surface migration.
  'agent:execute-action',
  'agent:get-registered-tools',
  'agent:has-tool-for-action',
  // ：会话代码根绑定——返回 `{success, ...}` legacy 形态，非 envelope。
  'agent:bind-session-code-root',
  'agent:get-session-code-root',
  'agent:clear-session-code-root',
  'agent:list-session-code-roots',
  'agent:rehome-session-code-root',
  // W6 批次 1：agent-engine:abort / agent-engine:get-state 已迁到 PlatformSurface
  'agent-engine:cancel-subagent',
  'agent-engine:check-pending',
  'agent-engine:invalidate-user-portrait-cache',
  //  阶段 C：草稿 session 预 acquire Runtime
  'agent-engine:prewarm-runtime',
  'agent-engine:mode-switch-execute',
  // Phase 3 F8/F9：UI 切 mode 时同步通知主进程
  'agent-engine:notify-mode-switched',
  // ：UI 切审批档时 live 同步运行中 session 的请求档（返回 {success, applied}）
  'agent-engine:notify-approval-mode-changed',
  'agent-engine:query',
  // ：会话观察意图握手（返回 legacy `{success}`）。
  'agent-engine:watch-session',
  'agent-engine:unwatch-session',
  'agent-engine:register-provisional-session',
  'agent-engine:begin-provisional-session-claim',
  'agent-engine:complete-provisional-session-claim',
  'agent-engine:begin-provisional-session-discard',
  'agent-engine:complete-provisional-session-discard',
  // ：出站遥控发送返回 GatewayResponse（`{ok, type, payload, error}`），caller 自判 ok。
  'agent-engine:gateway-send',
  // ：main-backed GatewayPort 复用 ws-gateway GatewayResponse，不走平台 envelope。
  'ws:agent-gateway-request',
  'ws:agent-gateway-send',
  'ws:agent-gateway-subscribe',
  'ws:agent-gateway-unsubscribe',
  'ws:agent-gateway-reconnect',
  'ws:agent-gateway-organization-ids',
  // ：出站 abort 返回 AbortRunResult（`{localHit, remoteRequested, ...}`），非 envelope。
  'agent-engine:abort-run',
  //  / ：Host 插队 promote 返回 `{promoted, abortedRunId, ...}` legacy；
  // live 发现未进白名单时 shim 抛 LEGACY_SHAPE，renderer 丢 abortedRunId 导致「已中断」标错。
  'agent-engine:promote-run',
  'agent-engine:cancel-queued-run',
  'agent-engine:withdraw-unanswered-turn',
  'agent-engine:read-snapshots',
  //  live 验证发现： 引入的两个本机 transcript 读取 channel 返回
  // `{success, hasLocal/messages}` legacy 形态但从未进白名单——shim 直接 throw、
  // renderer catch 后静默回落 DB，导致「本机正文以本地为权威」的冷启动路径
  // 一直没真正生效。与 read-snapshots 同款 legacy 透传，caller 自判 success。
  'agent-engine:has-local-transcript',
  'agent-engine:fork-local-session',
  'agent-engine:read-session-transcript',
  'agent-engine:rollback-session-timeline',
  'agent-engine:rollback-transcript',
  // v3.1 dogfood 修：子 Agent IPC handler 历史返回 `{ok:false, error: 'string'}`
  // 形态（不是 ipc-shim envelope 规范的 `{ok:false, error: {code, message}}`），
  // 这些 channel 没在 LEGACY 白名单里会被 ipc-shim 拦截成"returned ok:false without
  // a message"通用错误，把原始 error code（'subagent_not_found' 等）吞掉，导致
  // SubagentDetailPane 的 errorMessages 映射拿不到精确文案。
  // 同 read-snapshots 一样走 legacy 透传，caller 自己 `if (result.ok) {...}` 判断。
  'agent-engine:read-subagent-session',
  'agent-engine:list-subagent-runs',
  'agent-engine:reset-account-sync',
  'agent-engine:retry-tool',
  'agent-engine:set-session-context-tier',
  'agent-engine:skill-credential-invalidate',
  'agent-engine:submit-ask-user-response',
  'agent-engine:submit-hitl-batch',
  // （第二刀）：renderer dismiss HITL 面板走本通道收敛 pending 为
  // 「用户取消」终态。返回 `{success, error?, code?}` legacy 形态。
  'agent-engine:cancel-hitl-interaction',
  'agent-engine:update-context',
  // W6 批次 1：agent-security 3 个 handler 已迁到 PlatformSurface

  // ─── task / recommendation ────────────────────────────────────────
  // RunSession / TaskRecord domain objects, not envelope.
  'task:cancel',
  'task:cleanup',
  'task:clear',
  'task:create',
  'task:delete',
  'task:enqueue',
  'task:get',
  'task:getAll',
  'task:pause',
  'task:query',
  'task:resume',
  'task:resume-with-pagination',
  'task:select-recommendation',
  'task:start',
  'task:statistics',
  'task:storeInfo',
  'task:update',
  'task:update-metadata',
  'recommendation:generate',
  'recommendation:get-history',
  'recommendation:record-usage',

  // ─── telemetry ────────────────────────────────────────────────────
  // Bare ipcMain.handle in agent/platform/telemetry-ipc.ts (P2 in W1 §五,
  // planned W2). Returns void or fire-and-forget acks.
  'telemetry:event',
  'telemetry:mttr:resolved',
  'telemetry:mttr:start',

  // ─── localMcp ─────────────────────────────────────────────────────
  // ipc-lazy module. Mostly returns domain objects; some return
  // {ok: true} envelope-ish but no `data` field.
  'localMcp:attachConnection',
  'localMcp:deleteConnection',
  'localMcp:discover',
  'localMcp:getConnectionDetail',
  'localMcp:shareConnectionToOrganization',
  'localMcp:importCandidate',
  'localMcp:listConnections',
  'localMcp:probeConnection',
  'localMcp:cancelProbe',
  'localMcp:saveManualConnection',
  'localMcp:upsertOrganizationMirror',
  'localMcp:setConnectionEnabled',

  // ─── resource detection / monitor / pty / etc ────────────────────
  'resource-monitor:getSnapshot',
  'resourceDetection:captureResource',
  'resourceDetection:downloadBatch',
  'resourceDetection:downloadResource',
  'resourceDetection:fetchBuffer',
  'resourceDetection:downloadStream',
  'resourceDetection:getResources',
  'resourceDetection:inspectResource',
  'resourceDetection:listResources',
  'resourceDetection:parseM3U8',
  'resourceDetection:parseStream',
  'pty:agent-kill',
  'pty:agent-detach',
  'pty:getPaneStatuses',
  'pty:has',
  'pty:kill',
  'pty:list',
  'pty:listWithStatus',
  'pty:paste-image',
  'pty:readOutput',
  'pty:releaseThreadSession',
  'pty:resize',
  'pty:snapshot-clear',
  'pty:snapshot-delete',
  'pty:snapshot-load',
  'pty:snapshot-manifest',
  'pty:snapshot-save',
  'pty:spawn',
  'pty:write',
  'run-session:addEvent',
  'run-session:closeTab',
  'run-session:create',
  'run-session:endRun',
  'run-session:get',
  'run-session:hasActiveRunForView',
  'run-session:openTab',
  'run-session:registerView',
  'run-session:setActiveView',
  'run-session:switchTab',

  // ─── notification / sandbox / credential / browser-env / tabsite ──
  'notification:checkPermission',
  'notification:clearBadge',
  'notification:getHostState',
  'notification:getPermissionStatus',
  'notification:getPrefs',
  'notification:setBadgeCount',
  'notification:setPrefs',
  'sandbox:clear-approval-by-action-type',
  'sandbox:clear-approval-cache',
  'sandbox:get-approval-cache-stats',
  'sandbox:sync-approval-preferences',
  'credential-vault:autofill-dismiss',
  'credential-vault:autofill-select',
  'credential-vault:check-login-status',
  'credential-vault:clear-partition-cookies',
  'credential-vault:detect-browsers',
  'credential-vault:export-cookies-json',
  'credential-vault:extract-cookies',
  'credential-vault:extract-passwords',
  'credential-vault:get-partition-cookies',
  'credential-vault:import-cookies-json',
  'credential-vault:inject-cookies',
  'credential-vault:save-confirm',
  'credential-vault:save-dismiss',
  'credential-vault:save-undismiss',
  'browser-env:bind-space',
  'browser-env:create',
  'browser-env:delete',
  'browser-env:get-environment-for-space',
  'browser-env:get-partition',
  'browser-env:list',
  'browser-env:rename',
  'tabsite:getDevServerStatus',
  'tabsite:initTemplate',
  'tabsite:startDevServer',
  'tabsite:stopDevServer',

  // ─── tins / ui / widget-audit / agent-gateway ────────────────────
  'tins:cleanup-sandbox',
  'tins:get-activation-states',
  'tins:get-page-context',
  'tins:get-resolved-variables',
  'tins:prepare-sandbox',
  'tins:register-webview',
  'tins:set-instances',
  'tins:sync-page-context',
  'tins:toggle-panel',
  'tins:unregister-webview',
  'ui:report-theme',                    // returns {ok: true, theme} envelope-ish
  'widget-audit:append',                // returns {ok: true} envelope-ish
  'ws:agent-gateway-status-get',

  // ─── crawl-view / webcontentsview ─────────────────────────────────
  'crawl-view:cancelAnnotation',
  'crawl-view:cleanupCache',
  'crawl-view:destroyTabView',
  'crawl-view:executeScript',
  'crawl-view:findInPage',
  'crawl-view:getCacheStats',
  'crawl-view:getCDPEndpoint',
  'crawl-view:getHTML',
  'crawl-view:getNavigationState',
  'crawl-view:getPageInfo',
  'crawl-view:getProcessedContent',
  'crawl-view:getWebContentsId',
  'crawl-view:getZoomLevel',
  'crawl-view:goBack',
  'crawl-view:goForward',
  'crawl-view:hasView',
  'crawl-view:hide',
  'crawl-view:loadUrl',
  'crawl-view:reconcileOrphans',
  'crawl-view:reload',
  'crawl-view:screenshot',
  'crawl-view:setIgnoreMouseEventsForAttached',
  'crawl-view:setViewBounds',
  'crawl-view:setZoomLevel',
  'crawl-view:show',
  'crawl-view:stop',
  'crawl-view:stopFindInPage',
  'crawl-view:touch',
  'crawl-view:waitForSelector',
  'webcontentsview:closeDevTools',
  'webcontentsview:getAllViews',
  'webcontentsview:getCDPEndpoint',
  'webcontentsview:getView',
  'webcontentsview:openDevTools',

  // ─── webview-host ( webview 迁移 Phase 2) ──────────────────
  // 返回 legacy `{success, ...}` 形态，与 crawl-view:* 同口径；
  // 迁 envelope 与 crawl-view 家族一起做。
  'webview-host:announce',
  'webview-host:bind',
  'webview-host:navigate',
  'webview-host:discard-announce',
])

// ─── Ring buffer (consumed by W2-ζ IpcInspector) ──────────────────────

/**
 * Ring buffer capacity. Each record is < 1 KB after JSON.stringify
 * (args/result truncated to 200 chars each), so 200 entries ≈ 200 KB
 * peak — fits comfortably even on low-memory devices.
 *
 * If IpcInspector ever needs longer history, prefer adding a "drain to
 * disk" subscriber rather than growing the ring — keeping the in-memory
 * footprint bounded protects long-running renderer processes.
 */
const RING_BUFFER_SIZE = 200

const ringBuffer: IpcCallRecord[] = []
const subscribers = new Set<(record: IpcCallRecord) => void>()

function recordCall(rec: IpcCallRecord): void {
  ringBuffer.push(rec)
  if (ringBuffer.length > RING_BUFFER_SIZE) {
    // Discard the oldest entry. `shift()` on a 200-element array is O(n)
    // but n is tiny + rare (only at steady state); the alternative
    // (circular buffer with index) is harder to read in test diagnostics.
    ringBuffer.shift()
  }
  // Notify in-shim subscribers (audit log writers, renderer-mode hooks).
  // Errors in one subscriber must not affect others or the IPC call
  // itself — swallow + console.error so dev sees the bug but production
  // keeps moving.
  for (const sub of subscribers) {
    try {
      sub(rec)
    } catch (subscriberError) {
      console.error('[ipc-shim] IPC call subscriber threw:', subscriberError)
    }
  }
}

/**
 * Cheap monotonic-ish id for inspector records. nanoid is overkill here
 * (records are short-lived dev-only); we just need cross-record uniqueness
 * within a single renderer session.
 */
let inspectorIdCounter = 0
function nextInspectorId(): string {
  inspectorIdCounter += 1
  return `ipc-${Date.now()}-${inspectorIdCounter}`
}

/**
 * Push a record to the W2-ζ IpcInspector dev overlay.
 *
 * `dev-inspector-bridge.ts` is a thin pub-sub: in dev builds it forwards
 * to renderer subscribers, in prod builds it's a no-op (NODE_ENV guard
 * + esbuild dead-code-eliminate). We always call it — the cost is
 * negligible and keeps the call site uniform.
 *
 * Note we send **raw** args / result here (not the truncated `summary`
 * forms used by the in-shim ring buffer): IpcInspector's UI is expected
 * to display the full payload for dev debugging. Caller sites with
 * sensitive payloads (e.g. credential-vault) should rely on the
 * NODE_ENV guard rather than try to redact here.
 */
function pushToInspector(args: {
  channel: string
  rawArgs: unknown
  rawResult?: unknown
  rawError?: { code: string; message: string; detail?: unknown }
  status: 'ok' | 'error' | 'legacy'
  trace_id?: string
  duration_ms: number
  startedAt: number
}): void {
  notifyIpcCallForInspector({
    id: nextInspectorId(),
    source: 'ipc',
    channel: args.channel,
    args: args.rawArgs,
    result: args.rawResult,
    error: args.rawError,
    status: args.status,
    trace_id: args.trace_id,
    duration_ms: args.duration_ms,
    startedAt: args.startedAt,
  })
}

/**
 * Subscribe to all `invokeIpc` calls (success / error / legacy
 * passthrough). Used by W2-ζ `IpcInspector` dev overlay; future audit
 * log writers can also use this hook.
 *
 * Returns an unsubscribe function — call it on component unmount /
 * cleanup. Multiple subscribers are fine; each gets a copy of every
 * record.
 *
 * **Cost**: subscription is O(1); per-call notification is O(N) where
 * N = number of subscribers. Keep it small (typically 1-2 dev-only
 * consumers).
 */
export function subscribeIpcCalls(callback: (record: IpcCallRecord) => void): () => void {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}

/**
 * Snapshot of the current ring buffer. Returns a shallow copy so
 * callers can safely iterate while new records are pushed.
 *
 * Mainly used by IpcInspector on first mount to backfill the table
 * before live `subscribeIpcCalls` records arrive.
 */
export function getRecentIpcCalls(): readonly IpcCallRecord[] {
  return ringBuffer.slice()
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Distinguish wire envelopes from domain objects that also carry `ok: boolean`.
 *
 * Wire shapes (from `okResponse` / `errResponse` / ipc-lazy stubs):
 *   - ok:true  → must have `data`
 *   - ok:false → `error` is an object `{ code, message, ... }`
 *
 * Domain objects that must NOT match (LEGACY passthrough):
 *   - LocalMcpProbeSummary: `{ ok, probedAt, tools, error?: string }`
 *   - git/fs access checks: `{ ok: false, error: string }`
 *   - ui:report-theme: `{ ok: true, theme }` (no `data`)
 */
function isEnvelopeShape(v: unknown): v is IpcEnvelope {
  if (v === null || typeof v !== 'object') return false
  const ok = (v as { ok?: unknown }).ok
  if (typeof ok !== 'boolean') return false

  if (ok === false) {
    const error = (v as { error?: unknown }).error
    // Domain failures carry error as string; wire envelopes use structured object.
    if (typeof error === 'string') return false
    return error !== null && typeof error === 'object'
  }

  return 'data' in v
}

function extractTraceId(v: unknown): string | undefined {
  if (v === null || typeof v !== 'object') return undefined
  const tid = (v as { trace_id?: unknown }).trace_id
  return typeof tid === 'string' && tid.length > 0 ? tid : undefined
}

/**
 * Truncated JSON serialization for ring-buffer records. Args / result
 * objects can be large (file blobs, batch payloads) — we don't want
 * the buffer to balloon, but a 200-char preview is enough for
 * IpcInspector to spot the wrong call.
 *
 * Falls back to `String(v)` for unserializable values (cyclic refs /
 * BigInt / Function refs in args).
 */
function summarize(v: unknown, maxLen: number = 200): string {
  let s: string
  try {
    s = JSON.stringify(v)
    if (s === undefined) s = String(v)
  } catch {
    return '<unserializable>'
  }
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s
}

function redactUrlQueryStrings(value: unknown, depth: number = 0): unknown {
  if (depth > 8) return '<max-depth>'
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      return `${url.origin}${url.pathname}${url.search || url.hash ? '?<redacted>' : ''}`
    } catch {
      return value
    }
  }
  if (Array.isArray(value)) {
    return value.map(item => redactUrlQueryStrings(item, depth + 1))
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactUrlQueryStrings(item, depth + 1),
      ]),
    )
  }
  return value
}

const SENSITIVE_ARG_CHANNELS: ReadonlySet<string> = new Set([
  'oss:get-presigned-object',
])

function summarizeReplaceArgs(args: unknown[]): unknown[] {
  const input = args[0]
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return [{ invalid: true }]
  }
  const payload = input as { rootPath?: unknown; edits?: unknown }
  const edits = Array.isArray(payload.edits) ? payload.edits : []
  const rootPath = typeof payload.rootPath === 'string' ? payload.rootPath : ''
  const rootName = rootPath.split(/[\\/]/).filter(Boolean).pop() || '<unknown>'
  let textLength = 0
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) continue
    const item = edit as { expectedText?: unknown; replacement?: unknown }
    if (typeof item.expectedText === 'string') textLength += item.expectedText.length
    if (typeof item.replacement === 'string') textLength += item.replacement.length
  }
  return [{
    rootName,
    fileCount: new Set(
      edits
        .filter((edit): edit is { file: string } => (
          !!edit
          && typeof edit === 'object'
          && !Array.isArray(edit)
          && typeof (edit as { file?: unknown }).file === 'string'
        ))
        .map((edit) => edit.file),
    ).size,
    editCount: edits.length,
    textLength,
  }]
}

// ─── Main entrypoints ─────────────────────────────────────────────────

/**
 * Invoke a main-process IPC handler with envelope-aware unwrap.
 *
 * Behaviour summary (full contract in file-header docstring):
 *
 *   - Envelope `{ok:true, data}` → resolves with `data` typed as `T`.
 *   - Envelope `{ok:false, error}` → throws PlatformIpcError.
 *   - LEGACY_HANDLERS member → resolves with raw result (cast to `T`).
 *   - Anything else → throws PlatformIpcError(LEGACY_SHAPE).
 *   - Main-process throw → throws PlatformIpcError(IPC_REJECT).
 *
 * Always pushes a record to the ring buffer regardless of outcome.
 *
 * @param channel IPC channel name (must match the one registered via
 *                `guardedHandle` / `ipc-lazy` stub on the main side).
 * @param args   Forwarded to `ipcRenderer.invoke`.
 * @returns      The unwrapped data (envelope mode) or raw result
 *               (legacy mode), typed as the caller's `T`.
 * @throws PlatformIpcError on any failure path.
 */
export async function invokeIpc<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const startTime = Date.now()
  const observableArgs = SENSITIVE_ARG_CHANNELS.has(channel)
    ? ['<redacted>']
    : channel === 'fs:replaceInFiles'
      ? summarizeReplaceArgs(args)
      : args
  const argsSummary = summarize(observableArgs)

  let result: unknown
  try {
    result = await ipcRenderer.invoke(channel, ...args)
  } catch (rejectErr) {
    // Main-process threw (e.g. ipc-lazy module load failure, or
    // pre-W2-δ ipc-lazy "no handler" throw). Wrap in PlatformIpcError
    // so callers don't have to know the difference between a thrown
    // Error and an envelope ok:false.
    const message = rejectErr instanceof Error ? rejectErr.message : String(rejectErr)
    const duration = Date.now() - startTime
    recordCall({
      channel,
      status: 'error',
      error_code: 'IPC_REJECT',
      error_message: message,
      duration_ms: duration,
      args_summary: argsSummary,
      timestamp: startTime,
    })
    pushToInspector({
      channel,
      rawArgs: observableArgs,
      rawError: { code: 'IPC_REJECT', message },
      status: 'error',
      duration_ms: duration,
      startedAt: startTime,
    })
    throw new PlatformIpcError({
      code: 'IPC_REJECT',
      message,
      ipc_channel: channel,
    })
  }

  const traceId = extractTraceId(result)
  const diagnosticResult = channel === 'api:request'
    ? redactUrlQueryStrings(result)
    : result

  // ─── envelope ok:false short-circuit (applies to LEGACY channels too) ──
  // Even when the channel is in LEGACY_HANDLERS, if the main side returns
  // an envelope with ok:false (typically the ipc-lazy LOAD_FAILED /
  // HANDLER_NOT_FOUND paths that wrap *every* lazy channel regardless of
  // whether its happy path is envelope or raw), we MUST still throw —
  // otherwise the failure signal is silently swallowed by legacy
  // passthrough and the user sees an empty / undefined-shaped result with
  // no toast. This is the "wide-in / strict-out" treatment of D-3
  // ("不留 MVP，失败信号必须显式").
  //
  // Why not the symmetric ok:true unwrap for legacy channels too? Because
  // legacy callers expect raw `{success, ...}` and would break if we
  // unwrapped to `data` only on the success path. The ok:false path is
  // safe to short-circuit because legacy callers never hand-craft an
  // `{ok:false, error:{code,message}}` shape — that shape only comes from
  // the wire envelope helpers (`errResponse`) plus the ipc-lazy stub
  // wrapper, both of which carry trace_id and structured error.code.
  if (
    LEGACY_HANDLERS.has(channel)
    && isEnvelopeShape(result)
    && result.ok === false
  ) {
    const errEnv = result.error
    const code = typeof errEnv?.code === 'string' && errEnv.code.length > 0
      ? errEnv.code
      : 'UNKNOWN_ERROR'
    const message = typeof errEnv?.message === 'string' && errEnv.message.length > 0
      ? errEnv.message
      : `IPC ${channel} returned ok:false without a message`
    const duration = Date.now() - startTime
    recordCall({
      channel,
      status: 'error',
      trace_id: traceId,
      error_code: code,
      error_message: message,
      duration_ms: duration,
      args_summary: argsSummary,
      timestamp: startTime,
    })
    pushToInspector({
      channel,
      rawArgs: observableArgs,
      rawError: { code, message, detail: errEnv?.detail },
      status: 'error',
      trace_id: traceId,
      duration_ms: duration,
      startedAt: startTime,
    })
    throw new PlatformIpcError({
      code,
      message,
      ipc_channel: channel,
      trace_id: traceId,
      detail: errEnv?.detail,
    })
  }

  // Tier 1: legacy passthrough (whitelist) — happy paths and
  // legacy-shaped errors (`{success: false, error: 'string'}`) flow
  // through unmodified. Only the envelope ok:false case above is
  // intercepted.
  if (LEGACY_HANDLERS.has(channel)) {
    const duration = Date.now() - startTime
    recordCall({
      channel,
      status: 'legacy',
      trace_id: traceId,
      duration_ms: duration,
      args_summary: argsSummary,
      result_summary: summarize(diagnosticResult),
      timestamp: startTime,
    })
    pushToInspector({
      channel,
      rawArgs: observableArgs,
      rawResult: diagnosticResult,
      status: 'legacy',
      trace_id: traceId,
      duration_ms: duration,
      startedAt: startTime,
    })
    return result as T
  }

  // Tier 2: envelope-aware
  if (isEnvelopeShape(result)) {
    if (result.ok === true) {
      const duration = Date.now() - startTime
      recordCall({
        channel,
        status: 'ok',
        trace_id: traceId,
        duration_ms: duration,
        args_summary: argsSummary,
        result_summary: summarize(
          isEnvelopeShape(diagnosticResult) && diagnosticResult.ok
            ? diagnosticResult.data
            : diagnosticResult,
        ),
        timestamp: startTime,
      })
      pushToInspector({
        channel,
        rawArgs: observableArgs,
        rawResult: isEnvelopeShape(diagnosticResult) && diagnosticResult.ok
          ? diagnosticResult.data
          : diagnosticResult,
        status: 'ok',
        trace_id: traceId,
        duration_ms: duration,
        startedAt: startTime,
      })
      return result.data as T
    }
    // ok === false
    const errEnv = result.error
    const code = typeof errEnv?.code === 'string' && errEnv.code.length > 0
      ? errEnv.code
      : 'UNKNOWN_ERROR'
    const message = typeof errEnv?.message === 'string' && errEnv.message.length > 0
      ? errEnv.message
      : `IPC ${channel} returned ok:false without a message`
    const duration = Date.now() - startTime
    recordCall({
      channel,
      status: 'error',
      trace_id: traceId,
      error_code: code,
      error_message: message,
      duration_ms: duration,
      args_summary: argsSummary,
      timestamp: startTime,
    })
    pushToInspector({
      channel,
      rawArgs: observableArgs,
      rawError: { code, message, detail: errEnv?.detail },
      status: 'error',
      trace_id: traceId,
      duration_ms: duration,
      startedAt: startTime,
    })
    throw new PlatformIpcError({
      code,
      message,
      ipc_channel: channel,
      trace_id: traceId,
      detail: errEnv?.detail,
    })
  }

  // Tier 0: not envelope, not in LEGACY whitelist → developer accident.
  // Surfacing as throw is intentional (D-3 "no MVP, no silent acceptance"):
  // either the main-end handler should be migrated to envelope, or the
  // channel needs to be explicitly registered in LEGACY_HANDLERS with a
  // justification comment.
  const warnMsg = `[ipc-shim] Channel "${channel}" returned non-envelope shape and is not in LEGACY_HANDLERS. ` +
    `Either migrate the main-end handler to envelope (preferred) or add the channel to LEGACY_HANDLERS in apps/tabtin-electron/src/preload/ipc-shim.ts.`
  console.warn(warnMsg)
  const duration = Date.now() - startTime
  recordCall({
    channel,
    status: 'error',
    trace_id: traceId,
    error_code: 'LEGACY_SHAPE',
    error_message: warnMsg,
    duration_ms: duration,
    args_summary: argsSummary,
    result_summary: summarize(diagnosticResult),
    timestamp: startTime,
  })
  pushToInspector({
    channel,
    rawArgs: observableArgs,
    rawResult: diagnosticResult,
    rawError: { code: 'LEGACY_SHAPE', message: warnMsg },
    status: 'error',
    trace_id: traceId,
    duration_ms: duration,
    startedAt: startTime,
  })
  throw new PlatformIpcError({
    code: 'LEGACY_SHAPE',
    message: warnMsg,
    ipc_channel: channel,
    trace_id: traceId,
  })
}

/**
 * Fire-and-forget IPC dispatch (one-way event).
 *
 * Thin wrapper over `ipcRenderer.send` — there's no return value so no
 * envelope contract applies, but we still push a record to the ring
 * buffer (status='legacy', no result_summary) so IpcInspector can show
 * "X event sent at Tms" alongside invoke calls.
 *
 * **NOT used for `sendSync`** — synchronous IPC has its own legacy
 * path (`pty:snapshot-save-sync`); preload keeps the raw
 * `ipcRenderer.sendSync` call for that single channel and W2-δ adds a
 * sender guard on the main side.
 */
export function sendIpc(channel: string, ...args: unknown[]): void {
  const startTime = Date.now()
  const argsSummary = summarize(args)
  try {
    ipcRenderer.send(channel, ...args)
  } finally {
    const duration = Date.now() - startTime
    recordCall({
      channel,
      status: 'legacy',
      duration_ms: duration,
      args_summary: argsSummary,
      timestamp: startTime,
    })
    pushToInspector({
      channel,
      rawArgs: args,
      status: 'legacy',
      duration_ms: duration,
      startedAt: startTime,
    })
  }
}

// ─── Test-only helpers ────────────────────────────────────────────────

/**
 * Reset ring buffer + subscribers. Test-only; prod code must not call.
 *
 * vitest's `beforeEach` doesn't auto-clear module-level state — without
 * this, ring buffer entries from one test bleed into the next.
 */
export function __resetIpcShimForTesting(): void {
  ringBuffer.length = 0
  subscribers.clear()
}
