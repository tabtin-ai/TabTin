/**
 * FR-01 / FR-03 / FR-04 / FR-07 / FR-09 — shared host runtime options.
 *
 * Electron reads `doomLoopPolicy`, `maxMessageChars`,
 * `normalizationLevel`, `toolSchemaValidation` and `toolOutputScan`
 * from env so operators can flip them without re-packaging the app
 * when:
 *  - DoomLoop mis-fires on legitimate batch workloads,
 *  - 1 MB proves too tight for a pathological attachment,
 *  - the FR-03 normalizer needs to be rolled back during a bad release,
 *  - FR-07 schema validation false-positives on a legit caller (flip
 *    to `off` while the schema gets fixed),
 *  - FR-09 injection scan false-positives on a legitimate CLI/browser web-content source.
 *
 * All helpers fall back to the Runtime's own defaults (`'soft'` /
 * `DEFAULT_MAX_MESSAGE_CHARS` / `DEFAULT_NORMALIZATION_LEVEL` /
 * `DEFAULT_TOOL_SCHEMA_VALIDATION` / `true`), so a clean install
 * keeps the existing behaviour exactly.
 *
 * Kept in a dedicated module (not inside `ElectronAgentHost.ts`) so the
 * unit tests can import these pure helpers without pulling in the
 * `electron` module — the runtime host transitively depends on
 * `ipcMain` / `app`, which break under jsdom.
 *
 * Electron and Daemon select explicit profiles at their adapter seams.
 */

import {
  DEFAULT_ITERATION_BUDGET,
  DEFAULT_MAX_MESSAGE_CHARS,
  DEFAULT_NORMALIZATION_LEVEL,
  DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS,
  DEFAULT_TOOL_SCHEMA_VALIDATION,
} from '@tabtin/agent-runtime/engine'
import type {
  IterationBudgetConfig,
  NormalizationLevel,
  ToolFailureBudgetThresholds,
  ToolFailureTrackerConfig,
  ToolSchemaValidationLevel,
} from '@tabtin/agent-runtime/engine'

export type DoomLoopPolicy = 'soft' | 'strict'

export interface HostRuntimeOptionsLogger {
  warn(message: string): void
}

export interface HostRuntimeProfile {
  logLabel: 'AgentHost' | 'DaemonAgentHost'
  toolFailureLogLabel: 'ElectronAgentHost' | 'DaemonAgentHost'
  defaultMaxLocalFileSizeMb: number
}

/**
 * `TABTIN_DOOM_LOOP_POLICY` → `EngineConfig.doomLoopPolicy`.
 *
 * Accepts `'soft' | 'strict'` (case-insensitive). Any other value logs
 * a single warning and falls back to `'soft'` — louder than silent
 * fallback because this is a safety-impacting knob (strict terminates
 * on pause; mistyping `strictt` and getting `soft` back can mask bugs).
 */
export function resolveDoomLoopPolicy(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): DoomLoopPolicy {
  const raw = env.TABTIN_DOOM_LOOP_POLICY?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return 'soft'
  if (raw === 'soft' || raw === 'strict') return raw
  logger.warn(
    `[AgentHost] Invalid TABTIN_DOOM_LOOP_POLICY="${raw}"; falling back to 'soft'. ` +
      `Valid values: 'soft' | 'strict'.`,
  )
  return 'soft'
}

/**
 * `TABTIN_MAX_MESSAGE_CHARS` → `EngineConfig.maxMessageChars`.
 *
 * Accepts a positive finite integer. Non-numeric / zero / negative /
 * `NaN` logs a warning and falls back to the Runtime default so a
 * misconfigured host still gets OOM protection.
 */
export function resolveMaxMessageChars(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number {
  const raw = env.TABTIN_MAX_MESSAGE_CHARS?.trim()
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_MESSAGE_CHARS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_MAX_MESSAGE_CHARS="${raw}"; must be a positive finite number. ` +
        `Falling back to DEFAULT_MAX_MESSAGE_CHARS=${DEFAULT_MAX_MESSAGE_CHARS}.`,
    )
    return DEFAULT_MAX_MESSAGE_CHARS
  }
  return Math.floor(parsed)
}

/**
 * `TABTIN_NORMALIZATION_LEVEL` → `EngineConfig.normalizationLevel`.
 *
 * Accepts `'off' | 'conservative' | 'full'` (case-insensitive; trimmed).
 * Any other value logs a single warning and falls back to the Runtime
 * default (`DEFAULT_NORMALIZATION_LEVEL`, currently `'conservative'`) —
 * we warn rather than silently fall through because a typo of `'ful'`
 * or `'on'` would silently downgrade from the intended level.
 *
 * Re-exported `DEFAULT_NORMALIZATION_LEVEL` keeps the fallback consistent
 * with the runtime's own default if it ever changes.
 */
export function resolveNormalizationLevel(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): NormalizationLevel {
  const raw = env.TABTIN_NORMALIZATION_LEVEL?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return DEFAULT_NORMALIZATION_LEVEL
  if (raw === 'off' || raw === 'conservative' || raw === 'full') return raw
  logger.warn(
    `[AgentHost] Invalid TABTIN_NORMALIZATION_LEVEL="${raw}"; falling back to ` +
      `'${DEFAULT_NORMALIZATION_LEVEL}'. Valid values: 'off' | 'conservative' | 'full'.`,
  )
  return DEFAULT_NORMALIZATION_LEVEL
}

// ─── FR-18 Phase 2 (H2-E) cross-host parity：附件解析 knob ──────────

export type AttachmentStrategy = 'local_first' | 'cloud_only'

/**
 * `TABTIN_ATTACHMENT_STRATEGY` → `ElectronAgentHost.resolveDefaultAttachmentStrategy`
 * 等价契约。共享 helper 与 Daemon 同名同语义，保持运维同一份文档管两端。
 *
 * **W4 (2026-05-13)** 移除 `cloud_first` 死配置字面值（T8 / 总控 §三 F5）：旧
 * `cloud_first` 与 `cloud_only` 在 ElectronAgentHost / DaemonAgentHost 代码里是
 * 同一个 if 分支，从未真正实现"云端优先失败再本地"的差异语义。D1 不留兼容
 * 直接删除；运维文档同步说明。环境变量仍写 `cloud_first` 走 fallback warn。
 *
 * 默认 `'local_first'`（PRD FR-18 决策 9）。无效值 → warn + fallback。
 */
export function resolveAttachmentStrategy(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): AttachmentStrategy {
  const raw = env.TABTIN_ATTACHMENT_STRATEGY?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return 'local_first'
  if (raw === 'local_first' || raw === 'cloud_only') return raw
  logger.warn(
    `[AgentHost] Invalid TABTIN_ATTACHMENT_STRATEGY="${raw}"; falling back to ` +
      `'local_first'. Valid values: 'local_first' | 'cloud_only' ` +
      `(W4: 'cloud_first' is no longer accepted — use 'cloud_only' instead).`,
  )
  return 'local_first'
}

export function decodeAttachmentStrategyFromPayload(
  payload: Record<string, unknown>,
): AttachmentStrategy | undefined {
  const raw = payload.attachment_strategy
  return raw === 'local_first' || raw === 'cloud_only' ? raw : undefined
}

/**
 * Electron 默认本地处理上限（MB）。沿用 packages `DEFAULT_MAX_LOCAL_FILE_SIZE_MB=50`，
 * 与 Daemon 默认 20MB 形成"桌面更宽 / 服务器更保守"的对称（H2-E 决策 D1）。
 */
export const ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB = 50
export const DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB = 20

/**
 * `TABTIN_LOCAL_DOCPARSE_MAX_MB` → Electron 本地解析体积上限的**类型/值集对齐 helper**。
 *
 * **⚠️ 当前 Electron 侧未在生产代码路径接线**：`ElectronAgentHost.resolveOneAttachment`
 * 仍直接使用 packages 常量 `DEFAULT_MAX_LOCAL_FILE_SIZE_MB`（50MB）做体积预判与
 * oversize 文案。本 helper 与 Daemon host runtime options 保持**同名同语义同 env key**，
 * 但**不要在运维文档里宣称"同一个 env 双端生效"**——Daemon 已生效、Electron 未生效。
 *
 * **为什么保留**：
 *   1. 让 host runtime options 测试 + 跨宿主 parity 工具能形式化对齐两端
 *   2. 未来 RC3 或灰度收集到"桌面用户也想 env 调阈值"反馈后，可一行接到
 *      `ElectronAgentHost.resolveOneAttachment` 的 `maxBytes` 计算（见遗留项 L18）
 *
 * **如果你正在加新场景**：宁可现在就接到 ElectronAgentHost 的 maxBytes 计算，
 * 也不要继续依赖未接线的 helper 做对外承诺。
 *
 * 解析规则（与 Daemon 同集）：
 * - 接受正整数（MB）；上限 200MB（防止运维误填巨值致 worker OOM）
 * - 非数字 / ≤0 → warn + fallback `ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB`
 * - >200 → 截断到 200 + warn
 */
export function resolveMaxLocalFileSizeMb(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
  fallback = ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
): number {
  const raw = env.TABTIN_LOCAL_DOCPARSE_MAX_MB?.trim()
  if (raw === undefined || raw.length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_LOCAL_DOCPARSE_MAX_MB="${raw}"; must be a positive ` +
        `finite number. Falling back to ${fallback}MB.`,
    )
    return fallback
  }
  const HARD_CAP_MB = 200
  if (parsed > HARD_CAP_MB) {
    logger.warn(
      `[AgentHost] TABTIN_LOCAL_DOCPARSE_MAX_MB=${parsed} exceeds hard cap ${HARD_CAP_MB}MB; ` +
        `clamping to ${HARD_CAP_MB}. Reduce the value or split large documents.`,
    )
    return HARD_CAP_MB
  }
  return Math.floor(parsed)
}

/**
 * `TABTIN_TOOL_SCHEMA_VALIDATION` → `EngineConfig.toolSchemaValidation` (FR-07).
 *
 * Accepts `'off' | 'warn' | 'strict'` (case-insensitive; trimmed).
 * Any other value logs a single warning and falls back to the Runtime
 * default (`DEFAULT_TOOL_SCHEMA_VALIDATION`, currently `'warn'`).
 *
 * Why warn loudly instead of silent fallback: `'strict'` rejects bad
 * inputs without executing — a typo (`'strikt'`) silently downgrading
 * to `'warn'` removes the safety net the operator deliberately enabled,
 * which is exactly the failure mode FR-07 exists to prevent.
 */
export function resolveToolSchemaValidation(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): ToolSchemaValidationLevel {
  const raw = env.TABTIN_TOOL_SCHEMA_VALIDATION?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return DEFAULT_TOOL_SCHEMA_VALIDATION
  if (raw === 'off' || raw === 'warn' || raw === 'strict') return raw
  logger.warn(
    `[AgentHost] Invalid TABTIN_TOOL_SCHEMA_VALIDATION="${raw}"; falling back to ` +
      `'${DEFAULT_TOOL_SCHEMA_VALIDATION}'. Valid values: 'off' | 'warn' | 'strict'.`,
  )
  return DEFAULT_TOOL_SCHEMA_VALIDATION
}

/**
 * `TABTIN_TOOL_OUTPUT_SCAN` → `EngineConfig.toolOutputScan` (FR-09).
 *
 * Accepts boolean-shaped strings: `'on' | 'off' | 'true' | 'false' | '1' | '0'`
 * (case-insensitive; trimmed). Defaults to `true` (scanner ON).
 *
 * Operators reach for this when an upstream change in CLI/browser web-content
 * output starts triggering injection patterns en masse on a known-good
 * source — flipping to `off` is the emergency rollback while the
 * pattern catalogue gets retuned. Production should normally keep it on.
 */
export function resolveToolOutputScan(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): boolean {
  const raw = env.TABTIN_TOOL_OUTPUT_SCAN?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return true
  if (['on', 'true', '1', 'enabled'].includes(raw)) return true
  if (['off', 'false', '0', 'disabled'].includes(raw)) return false
  logger.warn(
    `[AgentHost] Invalid TABTIN_TOOL_OUTPUT_SCAN="${raw}"; falling back to ` +
      `'on'. Valid values: 'on' | 'off' | 'true' | 'false' | '1' | '0'.`,
  )
  return true
}

// ─── FR-15 IterationBudget options ────────────────────────────────────
//
// 双通路兜底（PRD §5.2 FR-15 / Q3 决策 E）：iteration 通路
// `_WARN_ITER` / `_GRACE_ITER` + token 通路 `_WARN_TOKEN` / `_GRACE_TOKEN`，
// 各自接受 (0, 1] 范围内的小数（warn=0.7 表示 70%）。terminate 阈值固定
// 为 1.0 不开放 env 调整——否则运维误填 0.5 会让 IterationBudget 失效，
// 反而失去优雅终止的意义。
//
// 单值非法 → warn + fallback 到该字段默认值（不污染其他字段）；整通路阈
// 值不满足 `warn < grace ≤ 1` → 整通路回落到默认值（与
// `normalizeIterationBudgetConfig` 的行为一致——避免局部修复产生反直觉）。
//
// 与其他 runtime option 共用 `[AgentHost]` 日志前缀；与 Daemon host runtime options
// 同名同语义同 env key，运维同一份文档管两端。

function resolveBudgetThreshold(
  env: NodeJS.ProcessEnv,
  envKey: string,
  fallback: number,
  logger: HostRuntimeOptionsLogger,
): number {
  const raw = env[envKey]?.trim()
  if (raw === undefined || raw.length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    logger.warn(
      `[AgentHost] Invalid ${envKey}="${raw}"; must be a finite number in (0, 1]. ` +
        `Falling back to default ${fallback}.`,
    )
    return fallback
  }
  return parsed
}

/**
 * `TABTIN_ITERATION_BUDGET_*` → `EngineConfig.iterationBudget`.
 *
 * 解析两通路四个阈值（terminate 固定 1.0）。返回结构与
 * `EngineConfig.iterationBudget` 一致，宿主直接 spread 进 EngineConfig
 * 即可。**未配置 / 全部默认时返回**与 `DEFAULT_ITERATION_BUDGET` 等价的
 * 完整对象（不返回 `undefined`），便于宿主侧"显式 SSoT"——下游
 * `normalizeIterationBudgetConfig` 仍会做兜底校验，环节冗余但安全。
 *
 * 校验失败的字段会经 `resolveBudgetThreshold` 各自 warn + fallback；
 * 通路级不变量（`warn < grace`）由 Runtime 侧 `normalizeIterationBudgetConfig`
 * 兜底——如果 env 配出 `WARN_ITER=0.95 GRACE_ITER=0.5` 这种倒置，整 iteration
 * 通路在 Runtime 进入主循环时回落默认值，env 这一层只做单值校验。
 */
export function resolveIterationBudget(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): IterationBudgetConfig {
  return {
    iteration: {
      warn: resolveBudgetThreshold(
        env,
        'TABTIN_ITERATION_BUDGET_WARN_ITER',
        DEFAULT_ITERATION_BUDGET.iteration.warn,
        logger,
      ),
      grace: resolveBudgetThreshold(
        env,
        'TABTIN_ITERATION_BUDGET_GRACE_ITER',
        DEFAULT_ITERATION_BUDGET.iteration.grace,
        logger,
      ),
      terminate: DEFAULT_ITERATION_BUDGET.iteration.terminate,
    },
    token: {
      warn: resolveBudgetThreshold(
        env,
        'TABTIN_ITERATION_BUDGET_WARN_TOKEN',
        DEFAULT_ITERATION_BUDGET.token.warn,
        logger,
      ),
      grace: resolveBudgetThreshold(
        env,
        'TABTIN_ITERATION_BUDGET_GRACE_TOKEN',
        DEFAULT_ITERATION_BUDGET.token.grace,
        logger,
      ),
      terminate: DEFAULT_ITERATION_BUDGET.token.terminate,
    },
  }
}

// ─── W3 · Stall detector options ───────────────────────────────────────
//
// 与 `iterationBudget` 同 ops 模式：daemon / electron 同名同语义同 env key，
// 运维同一份文档管两端。详细设计见 `engine/tool-failure-tracker.ts`。

function parseToolFailureStreak(
  env: NodeJS.ProcessEnv,
  envKey: string,
  fallback: number,
  logger: HostRuntimeOptionsLogger,
): number {
  const raw = env[envKey]?.trim()
  if (raw === undefined || raw.length === 0) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
    logger.warn(
      `[ElectronAgentHost] Invalid ${envKey}="${raw}"; must be a positive integer ≤ 100. ` +
        `Falling back to default ${fallback}.`,
    )
    return fallback
  }
  return Math.floor(parsed)
}

function parseToolFailureEnabled(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): boolean {
  const raw = env.TABTIN_TOOL_FAILURE_TRACKER_ENABLED?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return true
  if (['on', 'true', '1', 'enabled', 'yes'].includes(raw)) return true
  if (['off', 'false', '0', 'disabled', 'no'].includes(raw)) return false
  logger.warn(
    `[ElectronAgentHost] Invalid TABTIN_TOOL_FAILURE_TRACKER_ENABLED="${raw}"; falling back to ` +
      `'true'. Valid values: 'on' | 'off' | 'true' | 'false' | '1' | '0' | 'enabled' | 'disabled' | 'yes' | 'no'.`,
  )
  return true
}

/**
 * `TABTIN_TOOL_FAILURE_*` → `EngineConfig.toolFailureTracker` (W3).
 *
 * 解析四个 env：
 *   - `TABTIN_TOOL_FAILURE_NOTICE_STREAK` → thresholds.notice（默认 3）
 *   - `TABTIN_TOOL_FAILURE_NUDGE_STREAK` → thresholds.nudge（默认 5）
 *   - `TABTIN_TOOL_FAILURE_TERMINATE_STREAK` → thresholds.terminate（默认 8， 硬熔断档）
 *   - `TABTIN_TOOL_FAILURE_TRACKER_ENABLED` → enabled（默认 true）
 *
 * 不变量校验（notice < nudge < terminate）由 `tool-failure-tracker.ts::
 * mergeTrackerConfig` 兜底——非法时整 thresholds 回落默认 / terminate 抬到
 * nudge+1。host runtime options 这一层只校验单字段合法性。
 */
export function resolveToolFailureTracker(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): Partial<ToolFailureTrackerConfig> & {
  thresholds?: Partial<ToolFailureBudgetThresholds>
} {
  const enabled = parseToolFailureEnabled(env, logger)
  const notice = parseToolFailureStreak(
    env,
    'TABTIN_TOOL_FAILURE_NOTICE_STREAK',
    DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS.notice,
    logger,
  )
  const nudge = parseToolFailureStreak(
    env,
    'TABTIN_TOOL_FAILURE_NUDGE_STREAK',
    DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS.nudge,
    logger,
  )
  const terminate = parseToolFailureStreak(
    env,
    'TABTIN_TOOL_FAILURE_TERMINATE_STREAK',
    DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS.terminate,
    logger,
  )
  return {
    enabled,
    thresholds: { notice, nudge, terminate },
  }
}

// ─── FR-17（H3-C）子 Agent 治理 knob ─────────────────────────────────

/**
 * Default max concurrent child agents per BudgetTracker instance.
 *
 * 与 packages/agent-runtime 的 `BudgetTrackerOptions.maxConcurrentChildren`
 * 默认值同步（PRD §5.2 FR-17 决策"默认 5"）。在 host 层显式声明常量便于
 * 单测断言 + 灰度切换默认值时只改一处。
 */
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 5;

/**
 * `TABTIN_MAX_CONCURRENT_CHILDREN` → `EngineConfig.maxConcurrentChildren` (FR-17.1).
 *
 * 接受正整数（≥ 1）。`Infinity` / `unlimited` / `0` 三种 token 显式禁用限制
 * （`BudgetTracker` 内部把 ≤ 0 视为 Infinity，但 0 在 env 里语义模糊，所以
 * 这里 alias 了 `unlimited` / `infinity` 让运维表达意图更清楚）。
 *
 * 非数字 / 负数 → warn + fallback `DEFAULT_MAX_CONCURRENT_CHILDREN` (= 5)。
 *
 * 灰度运维场景：默认 5 偏保守；某些"研究型"用户希望 fan-out 10 并行子 Agent
 * 时可临时把 env 调到 10 重启 host；如果 PRD 后续上调默认值，只改
 * `DEFAULT_MAX_CONCURRENT_CHILDREN` 一处。
 */
export function resolveMaxConcurrentChildren(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number {
  const raw = env.TABTIN_MAX_CONCURRENT_CHILDREN?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_CONCURRENT_CHILDREN
  if (raw === 'unlimited' || raw === 'infinity' || raw === '0') return Number.POSITIVE_INFINITY
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_MAX_CONCURRENT_CHILDREN="${raw}"; must be a positive integer ` +
        `or 'unlimited' / 'infinity' / '0'. Falling back to ${DEFAULT_MAX_CONCURRENT_CHILDREN}.`,
    )
    return DEFAULT_MAX_CONCURRENT_CHILDREN
  }
  return Math.floor(parsed)
}

/**
 * W4 (2026-05-26)：子 Agent 排队队列默认上限（PRD §六 W4 D1 决策）。
 *
 * 与 5 active 配套形成 5/95 总并发 100 的格局。设计哲学（C3 派任务总是被接住）：
 * 保守 active 避免撞 LLM RPM；大 queue 让 LLM 派多少都接住，"队列满" 成为罕见
 * 兜底而不是常态。
 *
 * 与 packages/agent-runtime 的 `BudgetTrackerOptions.maxQueueSize` 默认值同步。
 */
export const DEFAULT_MAX_SUBAGENT_QUEUE = 95;

/**
 * `TABTIN_MAX_SUBAGENT_QUEUE` → `EngineConfig.maxSubagentQueue` (W4 D1).
 *
 * 接受非负整数（0 = 禁用排队，满即 error；与 maxConcurrentChildren=Infinity 互斥）。
 * 非数字 / 负数 → warn + fallback `DEFAULT_MAX_SUBAGENT_QUEUE` (= 95)。
 *
 * 灰度场景：默认 95 适配 W4 总控的"派 50+ 子 Agent 并行场景"；运维可调小到 25
 * 让 queue_full error 更早出现（提示用户分批派发）。
 */
export function resolveMaxSubagentQueue(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number {
  const raw = env.TABTIN_MAX_SUBAGENT_QUEUE?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return DEFAULT_MAX_SUBAGENT_QUEUE
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_MAX_SUBAGENT_QUEUE="${raw}"; must be a non-negative integer. ` +
        `Falling back to ${DEFAULT_MAX_SUBAGENT_QUEUE}.`,
    )
    return DEFAULT_MAX_SUBAGENT_QUEUE
  }
  return Math.floor(parsed)
}

/**
 * `TABTIN_SUBAGENT_RESULT_COMPACT` → `EngineConfig.subagentResultCompact` (FR-17.2).
 *
 * 接受 boolean-shaped strings：`'on' | 'off' | 'true' | 'false' | '1' | '0'`
 * （case-insensitive；trim）。默认 `true`（PRD §5.2 FR-17 决策"默认开启"）。
 *
 * 关闭后子 Agent summary 原样写到父 tool_result（A/B 测试 / 与 H3-B summary
 * reuse 兼容性核查场景）。生产正常应保持 `true`——关掉后长子任务 summary
 * 会污染父 context（PRD 明文风险）。
 */
export function resolveSubagentResultCompact(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): boolean {
  const raw = env.TABTIN_SUBAGENT_RESULT_COMPACT?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return true
  if (['on', 'true', '1', 'enabled'].includes(raw)) return true
  if (['off', 'false', '0', 'disabled'].includes(raw)) return false
  logger.warn(
    `[AgentHost] Invalid TABTIN_SUBAGENT_RESULT_COMPACT="${raw}"; falling back to ` +
      `'on'. Valid values: 'on' | 'off' | 'true' | 'false' | '1' | '0'.`,
  )
  return true
}

/**
 * FR-16 H3-B：`TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE` →
 * `EngineConfig.summaryReuseJudgeSampleRate`.
 *
 * 接受 [0, 1] 浮点数。`0` 关 judge 但保留 reuse；`1` 每次都跑 judge（开发者
 * 调试用，会让每次 reuse 多一次 LLM 调用）。其他非法值 → warn + 不覆盖默认（0.05）。
 *
 * 设计动机（H3-B Review fix）：原来 enableSummaryReuse 是"全开/全关"二选一，
 * 缺少"灰度发现 judge 调用费用过高想降采样到 1%"这种中间档。这与
 * `doomLoopPolicy` 的"二选一"模式不同——judge 可调采样率本身是产品需求。
 *
 * 返回 `undefined` 表示不覆盖（让引擎走默认）；返回 number 表示宿主显式注入。
 */
export function resolveSummaryReuseJudgeSampleRate(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number | undefined {
  const raw = env.TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_SUMMARY_REUSE_JUDGE_SAMPLE_RATE="${raw}"; must be a finite number in [0, 1]. ` +
        `Falling back to runtime default.`,
    )
    return undefined
  }
  return parsed
}

/**
 * FR-16 H3-B：`TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE` →
 * `EngineConfig.summaryReuseJudgeWindowSize`. 接受 ≥ 10 的正整数。
 */
export function resolveSummaryReuseJudgeWindowSize(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number | undefined {
  const raw = env.TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 10 || !Number.isInteger(parsed)) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_SUMMARY_REUSE_JUDGE_WINDOW_SIZE="${raw}"; must be an integer ≥ 10. ` +
        `Falling back to runtime default.`,
    )
    return undefined
  }
  return parsed
}

/**
 * FR-16 H3-B：`TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD` →
 * `EngineConfig.summaryReuseJudgeThreshold`. 接受 [0, 1] 浮点数。
 */
export function resolveSummaryReuseJudgeThreshold(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number | undefined {
  const raw = env.TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_SUMMARY_REUSE_JUDGE_THRESHOLD="${raw}"; must be a finite number in [0, 1]. ` +
        `Falling back to runtime default.`,
    )
    return undefined
  }
  return parsed
}

/**
 * FR-16 H3-B：`TABTIN_SUMMARY_REUSE_MAX_AGE_MS` → `EngineConfig.summaryReuseMaxAgeMs`.
 *
 * 接受非负整数（ms）；`0` 等价 `undefined`（不限）。
 * 适用场景：长 idle 后用户回来，希望强制一次 summary "全量 refresh" 避免老 summary 误导新一轮。
 */
export function resolveSummaryReuseMaxAgeMs(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number | undefined {
  const raw = env.TABTIN_SUMMARY_REUSE_MAX_AGE_MS?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_SUMMARY_REUSE_MAX_AGE_MS="${raw}"; must be a non-negative integer (ms). ` +
        `Falling back to runtime default (no age limit).`,
    )
    return undefined
  }
  return parsed === 0 ? undefined : parsed
}

/**
 * FR-16 H3-B：`TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES` →
 * `EngineConfig.summaryReuseMinAddedMessages`. 接受 ≥ 1 的整数。
 */
export function resolveSummaryReuseMinAddedMessages(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): number | undefined {
  const raw = env.TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES?.trim()
  if (raw === undefined || raw.length === 0) return undefined
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_SUMMARY_REUSE_MIN_ADDED_MESSAGES="${raw}"; must be an integer ≥ 1. ` +
        `Falling back to runtime default (3).`,
    )
    return undefined
  }
  return parsed
}

/**
 * FR-16 H3-B：`TABTIN_SUMMARY_REUSE` → `EngineConfig.enableSummaryReuse`.
 *
 * 接受 `'on'/'off'/'true'/'false'/'1'/'0'/'enabled'/'disabled'`（case-insensitive；
 * trim）。其他值警告一次后默认 `true`（对齐 PRD §5.2 + Q4 决策"默认开启"）。
 *
 * 默认 `true` 的理由：
 * - PRD §5.2 + Q4 决策已经拍板"默认开启不暴露给最终用户"。
 * - 终端用户感知不到此开关；它存在的意义是给开发者 / 运维一个**关闭路径**做
 *   A/B 或紧急回滚（与 `doomLoopPolicy='strict'` 同一 ops 模式）。
 *
 * 配置生效路径：env → resolveSummaryReuse → EngineConfig.enableSummaryReuse →
 * runCompactionPhase 透传给 compactConversation。
 */
export function resolveSummaryReuse(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): boolean {
  const raw = env.TABTIN_SUMMARY_REUSE?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return true
  if (['on', 'true', '1', 'enabled'].includes(raw)) return true
  if (['off', 'false', '0', 'disabled'].includes(raw)) return false
  logger.warn(
    `[AgentHost] Invalid TABTIN_SUMMARY_REUSE="${raw}"; falling back to true. ` +
      `Valid values: 'on' | 'off' | 'true' | 'false' | '1' | '0' | 'enabled' | 'disabled'.`,
  )
  return true
}

/**
 * 连续对话成熟化 · 事 3：`TABTIN_TIME_BASED_MICROCOMPACT` →
 * `EngineConfig.timeBasedMicroCompact`.
 *
 * 默认 **开启**（`enabled: true`，`gapThresholdMinutes: 30`，`keepRecent: 4`）——
 * 白名单工具集合由 runtime `COMPACTABLE_TOOLS_DEFAULT` 维护（web_search /
 * parse_document / read_file 等），宿主只负责总开关与阈值。
 *
 * 接受 `'on'/'off'/'true'/'false'/'1'/'0'/'enabled'/'disabled'`（case-insensitive；
 * trim）。其他值警告一次后回落默认（enabled=true）。
 *
 * 配置生效路径：env → resolveTimeBasedMicroCompact → EngineConfig →
 * query.ts `runCompactionPhase` 透传。
 */
export function resolveTimeBasedMicroCompact(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): { enabled: boolean; gapThresholdMinutes: number; keepRecent: number } {
  const defaultConfig = {
    enabled: true,
    gapThresholdMinutes: 30,
    keepRecent: 4,
  } as const

  const raw = env.TABTIN_TIME_BASED_MICROCOMPACT?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return { ...defaultConfig }
  if (['on', 'true', '1', 'enabled'].includes(raw)) return { ...defaultConfig, enabled: true }
  if (['off', 'false', '0', 'disabled'].includes(raw)) {
    return { ...defaultConfig, enabled: false }
  }
  logger.warn(
    `[AgentHost] Invalid TABTIN_TIME_BASED_MICROCOMPACT="${raw}"; falling back to enabled=true. ` +
      `Valid values: 'on' | 'off' | 'true' | 'false' | '1' | '0' | 'enabled' | 'disabled'.`,
  )
  return { ...defaultConfig }
}

/**
 *  第一波：`TABTIN_PRESSURE_THRESHOLDS` → `EngineConfig.pressureThresholds`.
 *
 * 格式：三个位于 (0, 1] 区间的数字，逗号分隔，依次为
 * `microCompactStart,llmSummaryStart,emergencyStart`（例如 `"0.75,0.85,0.95"`），
 * 排序须满足 `micro <= summary < emergency`——与云端下发 decode 及 runtime
 * `pressure-router` 三处同一口径（micro 允许与摘要档并线，表示关停微压缩独立档）。
 *
 * 默认 **不设置**（返回 `undefined`）——runtime 走 `DEFAULT_PRESSURE_THRESHOLDS`
 * （0.75 / 0.85 / 0.95）。此开关的存在意义是给开发者 / 运维一个不改代码调整
 * 压缩分档触发线的通道（例如小窗口模型想更早触发摘要压缩）。
 *
 * 非法输入（个数不对 / 非数字 / 越界 / 非递增）警告一次后返回 `undefined`
 * 回落 runtime 默认——与 runtime 侧 `resolvePressureThresholds` 的校验语义
 * 一致，双层防御。
 *
 * 配置生效路径：env → 本函数 → EngineConfig.pressureThresholds →
 * query.ts 透传 runCompactionPhase → compact/pressure-router.ts 分档。
 */
export function resolvePressureThresholds(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): { microCompactStart: number; llmSummaryStart: number; emergencyStart: number } | undefined {
  const raw = env.TABTIN_PRESSURE_THRESHOLDS?.trim()
  if (raw === undefined || raw.length === 0) return undefined

  const parts = raw.split(',').map((part) => Number(part.trim()))
  const inRange = (v: number) => Number.isFinite(v) && v > 0 && v <= 1
  const [microCompactStart, llmSummaryStart, emergencyStart] = parts
  const valid =
    parts.length === 3 &&
    inRange(microCompactStart) &&
    inRange(llmSummaryStart) &&
    inRange(emergencyStart) &&
    microCompactStart <= llmSummaryStart &&
    llmSummaryStart < emergencyStart

  if (!valid) {
    logger.warn(
      `[AgentHost] Invalid TABTIN_PRESSURE_THRESHOLDS="${raw}"; falling back to runtime defaults. ` +
        `Expected three numbers in (0, 1] with micro <= summary < emergency, e.g. "0.75,0.85,0.95".`,
    )
    return undefined
  }

  return { microCompactStart, llmSummaryStart, emergencyStart }
}

/**
 *  第三波：解码 `agent.prompt.forward` payload 里云端 AdminDash 配置的
 * 压缩分档阈值（wire 字段 `pressure_thresholds`，snake_case）。
 *
 * 来源链路：AdminDash 上下文管理页 → Django `EngineRuntimeConfig`（三档语义
 * 映射见该模型注释）→ `prompt_forward_service._resolve_pressure_threshold_fields`
 * → wire payload → 本函数 → 宿主按「云端 > env 旋钮 > runtime 默认」合成
 * `EngineConfig.pressureThresholds`。
 *
 * 校验与 runtime `pressure-router` 同口径：三值均在 (0, 1] 且
 * `microCompactStart <= llmSummaryStart < emergencyStart`（micro 允许与摘要档
 * 起点重合 = 微压缩区间收空）。Django 侧发出前已做同款校验，这里是宿主端
 * 防御层——旧版 Django / 畸形 payload 一律返回 `undefined` 回落 env / 默认。
 */
export function decodeCloudPressureThresholds(
  raw: unknown,
  logger: HostRuntimeOptionsLogger,
): { microCompactStart: number; llmSummaryStart: number; emergencyStart: number } | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const obj = raw as Record<string, unknown>
  const microCompactStart = Number(obj.micro_compact_start)
  const llmSummaryStart = Number(obj.llm_summary_start)
  const emergencyStart = Number(obj.emergency_start)
  const inRange = (v: number) => Number.isFinite(v) && v > 0 && v <= 1
  const valid =
    inRange(microCompactStart) &&
    inRange(llmSummaryStart) &&
    inRange(emergencyStart) &&
    microCompactStart <= llmSummaryStart &&
    llmSummaryStart < emergencyStart
  if (!valid) {
    logger.warn(
      `[AgentHost] Invalid cloud pressure_thresholds payload ${JSON.stringify(raw)}; ` +
        `falling back to env/runtime defaults. Expected numbers in (0, 1] with ` +
        `micro_compact_start <= llm_summary_start < emergency_start.`,
    )
    return undefined
  }
  return { microCompactStart, llmSummaryStart, emergencyStart }
}

/**
 * FR-14：`TABTIN_SYNC_PERSISTENCE` → `EngineConfig.syncPersistence`.
 *
 * 接受 `'1' | '0' | 'true' | 'false' | 'on' | 'off'`（case-insensitive；
 * trim）。其他值警告一次后默认 `false`（保持 v1 兼容，不强制启用）。
 *
 * 默认 `true`（dogfood 修复：InMemoryPersistentQueue 导致 Electron
 * 重载后未同步消息丢失，改为默认开启文件持久化）。
 *
 * 配置生效路径：
 *   env → resolveSyncPersistence → EngineConfig.syncPersistence →
 *   ElectronAgentHost 决定注入 FilePersistentQueue（true）还是
 *   InMemoryPersistentQueue（false）到 SyncQueue。
 */
export function resolveSyncPersistence(
  env: NodeJS.ProcessEnv,
  logger: HostRuntimeOptionsLogger,
): boolean {
  const raw = env.TABTIN_SYNC_PERSISTENCE?.trim().toLowerCase()
  if (raw === undefined || raw.length === 0) return true
  if (raw === '1' || raw === 'true' || raw === 'on') return true
  if (raw === '0' || raw === 'false' || raw === 'off') return false
  logger.warn(
    `[AgentHost] Invalid TABTIN_SYNC_PERSISTENCE="${raw}"; falling back to false. ` +
      `Valid values: '1' | '0' | 'true' | 'false' | 'on' | 'off'.`,
  )
  return false
}

function withLogLabel(
  logger: HostRuntimeOptionsLogger,
  label: HostRuntimeProfile['logLabel'] | HostRuntimeProfile['toolFailureLogLabel'],
): HostRuntimeOptionsLogger {
  return {
    warn(message) {
      logger.warn(message.replace(
        /^\[(?:AgentHost|ElectronAgentHost)\]/,
        `[${label}]`,
      ))
    },
  }
}

export function createHostRuntimeOptions(profile: HostRuntimeProfile) {
  const bind = <Result>(
    resolver: (env: NodeJS.ProcessEnv, logger: HostRuntimeOptionsLogger) => Result,
    label: HostRuntimeProfile['logLabel'] | HostRuntimeProfile['toolFailureLogLabel']
      = profile.logLabel,
  ): ((env: NodeJS.ProcessEnv, logger: HostRuntimeOptionsLogger) => Result) => (
    env,
    logger,
  ) => (
    resolver(env, withLogLabel(logger, label))
  )

  return {
    resolveDoomLoopPolicy: bind(resolveDoomLoopPolicy),
    resolveMaxMessageChars: bind(resolveMaxMessageChars),
    resolveNormalizationLevel: bind(resolveNormalizationLevel),
    resolveAttachmentStrategy: bind(resolveAttachmentStrategy),
    resolveMaxLocalFileSizeMb: (
      env: NodeJS.ProcessEnv,
      logger: HostRuntimeOptionsLogger,
    ) => resolveMaxLocalFileSizeMb(
      env,
      withLogLabel(logger, profile.logLabel),
      profile.defaultMaxLocalFileSizeMb,
    ),
    resolveToolSchemaValidation: bind(resolveToolSchemaValidation),
    resolveToolOutputScan: bind(resolveToolOutputScan),
    resolveIterationBudget: bind(resolveIterationBudget),
    resolveToolFailureTracker: bind(
      resolveToolFailureTracker,
      profile.toolFailureLogLabel,
    ),
    resolveMaxConcurrentChildren: bind(resolveMaxConcurrentChildren),
    resolveMaxSubagentQueue: bind(resolveMaxSubagentQueue),
    resolveSubagentResultCompact: bind(resolveSubagentResultCompact),
    resolveSummaryReuseJudgeSampleRate: bind(resolveSummaryReuseJudgeSampleRate),
    resolveSummaryReuseJudgeWindowSize: bind(resolveSummaryReuseJudgeWindowSize),
    resolveSummaryReuseJudgeThreshold: bind(resolveSummaryReuseJudgeThreshold),
    resolveSummaryReuseMaxAgeMs: bind(resolveSummaryReuseMaxAgeMs),
    resolveSummaryReuseMinAddedMessages: bind(resolveSummaryReuseMinAddedMessages),
    resolveSummaryReuse: bind(resolveSummaryReuse),
    resolveTimeBasedMicroCompact: bind(resolveTimeBasedMicroCompact),
    resolvePressureThresholds: bind(resolvePressureThresholds),
    decodeCloudPressureThresholds: (
      raw: unknown,
      logger: HostRuntimeOptionsLogger,
    ) => decodeCloudPressureThresholds(
      raw,
      withLogLabel(logger, profile.logLabel),
    ),
    resolveSyncPersistence: bind(resolveSyncPersistence),
  }
}

export type HostRuntimeOptions = ReturnType<typeof createHostRuntimeOptions>

export const electronHostRuntimeOptions = createHostRuntimeOptions({
  logLabel: 'AgentHost',
  toolFailureLogLabel: 'ElectronAgentHost',
  defaultMaxLocalFileSizeMb: ELECTRON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
})

export const daemonHostRuntimeOptions = createHostRuntimeOptions({
  logLabel: 'DaemonAgentHost',
  toolFailureLogLabel: 'DaemonAgentHost',
  defaultMaxLocalFileSizeMb: DAEMON_DEFAULT_MAX_LOCAL_FILE_SIZE_MB,
})
