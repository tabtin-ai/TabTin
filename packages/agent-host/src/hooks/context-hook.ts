/**
 * Context Hook —— 每轮把 Tab/App context 注入 messages（贴当前 user turn 尾部）。
 *
 * **归属（ Phase 1）**：本 hook 原名 `buildContextInjectorHook`，住在
 * `@tabtin/agent-runtime` 的 `capability/injectors/context-injector.ts`。因它依赖
 * `@tabtin/agent-prompt`（产品内容包），随「引擎零业务依赖」重构迁到宿主
 * `@tabtin/agent-host/hooks`。行为与原实现逐字节一致——只换了归属与工厂名
 * （`buildContextInjectorHook` → `buildContextHook`）。
 *
 * **行为**：每轮 LLM 前从宿主拉取当前焦点 App 元数据（appType / appMeta /
 * openTabs / spaceId），包成 `<context type="environment">...</context>` 的
 * user message 注入到「紧贴当前 user 消息之前」，让 Agent 知道用户所在界面。
 *
 * **注入位置**：插到当前 user 消息之前（贴 user turn 尾部），历史前缀
 * byte-stable，保 prompt cache。
 *
 * **幂等闸门（ / per-run）**：本 run 已注入过（marker 仍在）则跳过——环境
 * 快照按 run 冻结以保 prompt cache（召回块随 todo 刷新的诉求相反，已拆到
 * relevant-recall hook）。
 */

import { buildUserContextWrapper, formatAgentDatetime, findFirstUserContextWrapper } from '@tabtin/agent-prompt'
import type { Message, EngineHooks } from '@tabtin/agent-runtime/engine'
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  findLastRealUserIndex,
  firstMessageText,
} from '@tabtin/agent-runtime/engine'
import { upsertTaggedBlock } from './message-inject.js'

// ─── Public Types ────────────────────────────────────────────────────

export interface AppContextTab {
  type: string
  id?: string
  title?: string
  active?: boolean
  group_id?: string
  // ─── Agent-facing 预解析字段（2026-05-14 重构）───────────────────
  // 由 renderer `useChatPanelContext.openTabs` 填充，让 context hook 在 main
  // 进程零 case-switch 渲染。详见 useChatPanelContext.ts:resolveTab 注释。
  /**
   * 真正的 App 类型（apphome 时取 meta.appId）。譬如：
   *   - 用户在某个 App 首页：type='apphome', app_key='tabdoc', is_home=true
   *   - 用户在具体的多维表： type='tabdata', app_key='tabdata', is_home=undefined
   */
  app_key?: string
  /** Agent-facing 中文显示名（"多维表" / "文档" / ...）。来自 handler.agent.displayName。 */
  display_name?: string
  /** 是否是该 App 的首页（resource list / launcher 页）。 */
  is_home?: boolean
  // ─── 兼容字段 ────────────────────────────────────────────────
  /** apphome 兼容字段：等同 app_key（is_home=true 时）；保留以便老消费者继续可用。 */
  app_home?: string
  // ─── 可选 meta（来自 useChatPanelContext.openTabs，按 tab 类型不同填充）───
  /** tabcode / tabfolder：项目或目录的本地路径 */
  path?: string
  /** tabfolder：'user' | 'sandbox' */
  kind?: string
  /** tabweb：当前页 URL */
  url?: string
  /** terminal：PTY session id（一般等于 tab.id，但保留语义独立） */
  session_id?: string
}

/**
 * 宿主焦点上下文。
 *
 * **Focus 核心字段**（`appType` / `appMeta` / `openTabs` / `spaceId` /
 * `userTimeZone` / `workspaceMode`）对齐 `@tabtin/contracts` 的
 * `FocusSnapshot`——wire `app_context` 与 Django normalizer 共用该合同。
 * 下列 host-only 字段（scope / 当前模型等）不进 FocusSnapshot，由宿主自行附加。
 */
export interface AppContext {
  // ── FocusSnapshot 对齐（核心）──────────────────────────────────────
  /** Current focused app type, e.g. 'tabdata', 'tabdoc', 'tabweb' */
  appType?: string | null
  /** App-specific metadata (table name, doc title, URL, etc.) */
  appMeta?: Record<string, unknown> | null
  /** All open tabs */
  openTabs?: AppContextTab[] | null
  /** Current space ID */
  spaceId?: string | null
  /**
   * 用户设备 IANA 时区名（譬如 `Asia/Shanghai`），由客户端采集后每轮透传。
   *
   * 用于把 `current_datetime` 按**用户设备时区**渲染，而不是 host（Daemon/Cloud
   * 可能在另一个时区）的本地时区或裸 UTC。缺省 → UTC（显式标注，安全降级）。
   * 详见 `@tabtin/agent-prompt` 的 `formatAgentDatetime`。
   */
  userTimeZone?: string | null
  /** 当前工作台模式，给 LLM 理解用户所在界面；不用于决定工具写入桶。 */
  workspaceMode?: 'conversation' | 'desktop' | 'non-space' | null

  // ── host-only（不进 FocusSnapshot 合同）────────────────────────────
  /**
   * 当前桌面/对话 workspace scope key。Electron 对话模式用
   * `conversation:{sessionId}` 作为可见 tab 桶；该字段供宿主透传给
   * ToolContext，不渲染进 LLM 的 `<context>` 文本。
   */
  tabScopeKey?: string | null
  /** `tabScopeKey` 的语义别名，便于调用方按 workspace 语义命名。 */
  workspaceScopeKey?: string | null
  /**
   * ：本轮实际执行的模型（会话 `current_model_id` / runtime modelId）。
   * 与 Agent.preferred_model_id（新对话默认）不同；回答「当前用什么模型」以本字段为准。
   */
  currentModelId?: string | null
  /** 本轮模型展示名（目录 displayName / Codex 预置名）；缺省时可与 id 相同。 */
  currentModelDisplayName?: string | null
}

/**
 * 宿主注入的「App 详情行」渲染器：给定当前焦点 App 的 type + 已透传的 meta，
 * 返回要拼进 environment context `details:` 段的文本行；无可渲染字段 / 不认识的
 * App 类型时返回空数组（本轮不输出详情段）。
 */
export type AppMetaFormatter = (
  appType: string,
  meta: Record<string, unknown>,
) => string[]

export interface ContextHookOptions {
  /**
   * Async callback that returns the current app context.
   * Called at every beforeIteration — must be fast (< 50ms).
   * Returning null/undefined skips injection for that iteration.
   */
  getAppContext: () => Promise<AppContext | null | undefined>
  /** Max character budget for injected context (default 3000) */
  charBudget?: number
  /**
   * 宿主注入的 App 详情行渲染器（见 {@link AppMetaFormatter}）。不传 → environment
   * context 不输出 App 详情段，只保留 focused / open_tabs 等中性框架。
   */
  formatAppMeta?: AppMetaFormatter
}

// ─── Internal Constants ──────────────────────────────────────────────

const DEFAULT_CHAR_BUDGET = 3000
const CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION
// ：历史里已落库的 environment context 块由 query.ts 装填后打此 marker。
const HISTORICAL_CONTEXT_MARKER = INTERNAL_MESSAGE_MARKERS.HISTORICAL_CONTEXT
// ：环境未变时的声明文本——只发时间 + 这句，不重复完整环境，省 token。
const ENV_UNCHANGED_NOTE = '(环境未变，同上一条 environment context)'
const DATETIME_LINE_PREFIX = 'current_datetime:'
const NON_APP_FOCUS_KEYS = new Set(['apphome', 'chat'])

/**
 * ：environment context / focusedApp 也不向 Agent 暴露这些 App（与
 * ContextRegistry.TEMPORARILY_HIDDEN_AGENT_APP_IDS 对齐）。入口已藏或未交付时，
 * 打开的残余 tab 也不注入文本。
 */
const PROMPT_HIDDEN_APP_IDS = new Set([
  'tabsite',
  'tabwhiteboard',
  'tabvideo',
  'tabmail',
  'tabphone',
  'tabinbox',
  // ：tabslide 恢复进 `<apps>` / environment context；UI 入口仍可由
  // TABSLIDE_UI_ENABLED 隐藏，残余 tab 允许注入以便 Agent 操作已打开的演示。
])

function isPromptHiddenAppId(value: unknown): boolean {
  if (typeof value !== 'string') return false
  return PROMPT_HIDDEN_APP_IDS.has(value.trim().toLowerCase())
}

function isPromptHiddenAppTab(tab: AppContextTab): boolean {
  return (
    isPromptHiddenAppId(tab.app_key)
    || isPromptHiddenAppId(tab.app_home)
    || isPromptHiddenAppId(tab.type)
  )
}

function normalizeFocusedAppKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const app = value.trim().toLowerCase()
  if (!app || NON_APP_FOCUS_KEYS.has(app)) return null
  return app
}

/**
 * 从宿主传入的 AppContext 中提取当前 focused App 的稳定 app key。
 *
 * 优先 active tab 的 renderer 预解析字段（apphome 时 app_key 才是真 App），再回退
 * `ctx.appType`。返回 null 表示当前焦点不是具体 App（如 chat panel）。
 */
export function getFocusedAppKey(ctx: AppContext | null | undefined): string | null {
  const activeTab = ctx?.openTabs?.find((t) => t.active)
  const key =
    normalizeFocusedAppKey(activeTab?.app_key) ??
    normalizeFocusedAppKey(activeTab?.app_home) ??
    normalizeFocusedAppKey(activeTab?.type) ??
    normalizeFocusedAppKey(ctx?.appType)
  // 不向 Agent 暴露的 App，也不作为 focusedApp 驱动相关 Skill 召回。
  if (key && isPromptHiddenAppId(key)) return null
  return key
}

/**
 * 从一条 environment context 块的完整 wrapper 文本里抽出「环境部分」（去掉每轮变化的
 * current_datetime 行后剩余内容）。声明块（环境未变）抽出的就是 `ENV_UNCHANGED_NOTE`。
 * 非 environment wrapper → null。
 */
function extractEnvBody(contextContent: string): string | null {
  const wrapper = findFirstUserContextWrapper(contextContent)
  if (!wrapper || wrapper.type !== 'environment') return null
  return wrapper.body
    .split('\n')
    .filter((l) => !l.startsWith(DATETIME_LINE_PREFIX))
    .join('\n')
    .trim()
}

/**
 * ：往前找「历史里最近一条**含真实环境**的 context 块」的环境部分，跳过仅声明
 * 「环境未变」的块（否则连续多轮未变时会把声明误当基线）。无则返回 null。
 */
function findLastRealEnvBody(messages: Message[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (!hasInternalMarker(messages[i]!, HISTORICAL_CONTEXT_MARKER)) continue
    const text = firstMessageText(messages[i]!)
    if (text === null) continue
    const env = extractEnvBody(text)
    if (env === null || env === ENV_UNCHANGED_NOTE) continue
    return env
  }
  return null
}

/**
 * ：拼本轮 environment context 的 body —— 时间行 + 环境部分。环境与「历史里
 * 最近一条真实环境」相同 → 只发时间 + 声明（省 token）；不同 / 首次 → 时间 + 完整环境；
 * 无环境信息 → 只发时间。纯函数，便于单测。
 */
function buildContextBody(
  ctx: AppContext,
  filtered: Message[],
  budget: number,
  formatAppMeta: AppMetaFormatter | undefined,
): string {
  const datetimeLine = `${DATETIME_LINE_PREFIX} ${formatAgentDatetime(new Date().toISOString(), ctx.userTimeZone)}`
  const envBody = buildContextText(ctx, budget, formatAppMeta).trim()
  if (envBody === '') return datetimeLine
  const lastRealEnv = findLastRealEnvBody(filtered)
  if (lastRealEnv !== null && lastRealEnv === envBody) {
    return `${datetimeLine}\n\n${ENV_UNCHANGED_NOTE}`
  }
  return `${datetimeLine}\n${envBody}`
}

async function safeGetAppContext(
  getAppContext: ContextHookOptions['getAppContext'],
): Promise<AppContext | null | undefined> {
  try {
    return await getAppContext()
  } catch {
    return null
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * 构造 context hook —— 每轮 beforeIteration 把宿主返回的 AppContext 渲染成
 * `<context type="environment">` user message 注入到当前 user 消息之前。
 * per-run 幂等闸门：本 run 已注入过则跳过（保 prompt cache）。content 为**裸 string**
 * （与历史重建形态一致、跨轮 byte-stable）。插位 = findLastRealUserIndex，<0 时 append。
 */
export function buildContextHook(options: ContextHookOptions): EngineHooks {
  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET
  const { getAppContext, formatAppMeta } = options
  return {
    async beforeIteration(ctx): Promise<void> {
      const state = ctx.state
      // per-run 幂等闸门：本 run 已注入过（marker 仍在）→ 跳过，不改 messages。
      if (state.messages.some((m) => hasInternalMarker(m, CONTEXT_MARKER))) return

      const appCtx = await safeGetAppContext(getAppContext)
      // 无环境信息 → 本轮不注入，保原引用（与原 per-run onNoInject 不写回一致）。
      if (!appCtx) return

      // filtered：摘掉本 marker 旧块（闸门已保证无本轮 fresh 块，等价于原数组内容）。
      const filtered = state.messages.filter((m) => !hasInternalMarker(m, CONTEXT_MARKER))
      // ：context = 时间（每轮发、落库即冻结）+ 环境（仅变化时发完整内容）。
      // 阶段 6 议题 2：统一走 user-context-wrapper SSoT `<context type="environment">`。
      const body = buildUserContextWrapper(
        'environment',
        buildContextBody(appCtx, filtered, charBudget, formatAppMeta),
      )
      // ：注入到「紧贴当前 user 消息之前」；找不到真用户消息 → append 末尾。
      // content 为裸 string（跨轮 byte-stable）。
      state.messages = upsertTaggedBlock(state.messages, {
        marker: CONTEXT_MARKER,
        content: body,
        position: (f) => {
          const insertAt = findLastRealUserIndex(f)
          return insertAt < 0 ? f.length : insertAt
        },
      })
    },
  }
}

// ─── Context Text Builder ────────────────────────────────────────────

/** 剔除 prompt 隐藏 App 后再渲染 environment，避免 focused / open_tabs / details 泄漏。 */
function sanitizeAppContextForPrompt(ctx: AppContext): AppContext {
  const openTabs = Array.isArray(ctx.openTabs)
    ? ctx.openTabs.filter((tab) => !isPromptHiddenAppTab(tab))
    : ctx.openTabs
  const appType = isPromptHiddenAppId(ctx.appType) ? null : ctx.appType
  const appMeta = isPromptHiddenAppId(ctx.appType) ? null : ctx.appMeta
  return {
    ...ctx,
    appType,
    appMeta,
    openTabs,
  }
}

// ：本函数只渲染「环境部分」（不含 current_datetime）。时间由 beforeIteration
// 单独拼在前面——这样可单独比较「环境部分」是否跨轮变化，未变时只发时间 + 声明。
function buildContextText(
  ctx: AppContext,
  budget: number,
  formatAppMeta: AppMetaFormatter | undefined,
): string {
  const safeCtx = sanitizeAppContextForPrompt(ctx)
  const lines: string[] = []

  // 2026-05-14：space_id 行已下线——同一事实由 system prompt 的 `<environment>` 段
  // 在装配期固化（Space 名 + UUID）。ctx.spaceId 字段保留作 hook 入参兼容。

  // ：本轮实际执行模型——与 Agent 首选解耦，供自述对齐选择器。
  const modelId = typeof safeCtx.currentModelId === 'string' ? safeCtx.currentModelId.trim() : ''
  if (modelId) {
    const display =
      (typeof safeCtx.currentModelDisplayName === 'string' && safeCtx.currentModelDisplayName.trim())
      || modelId
    lines.push(`current_model: ${display}`)
    lines.push(`current_model_id: ${modelId}`)
    lines.push(
      '注：回答「当前使用什么大模型」时以 current_model / current_model_id 为准（本轮实际执行），不要用 Agent 首选模型或历史自述。',
    )
    lines.push('')
  }

  if (safeCtx.workspaceMode === 'conversation') {
    lines.push('workspace_mode: conversation（工具打开的页面会显示在当前对话的右侧画布）')
  } else if (safeCtx.workspaceMode === 'desktop') {
    lines.push('workspace_mode: desktop（工具打开的页面会显示在桌面工作台）')
  }

  // 用户当前焦点：优先用 active tab 的 display_name + is_home（renderer 预解析），
  // 没有 active tab 才回退到 chat panel / unknown 兜底。
  const focusedLine = buildFocusedLine(safeCtx)
  if (focusedLine) lines.push(focusedLine)

  // 具体 App 的 meta 详情段由宿主注入的 formatAppMeta 渲染（中性框架不认识具体 App
  // 的字段口径 / 产品名 / CLI 配方）。formatter 对不认识的 App 类型 / 无可渲染字段返回
  // 空数组——此时不 push 详情段。未注入 formatter → 不输出详情段。
  if (safeCtx.appType && formatAppMeta) {
    const appLines = formatAppMeta(safeCtx.appType, safeCtx.appMeta ?? {})
    if (appLines.length > 0) {
      lines.push('')
      lines.push(...appLines)
    }
  }

  if (Array.isArray(safeCtx.openTabs)) {
    if (safeCtx.openTabs.length > 0) {
      const tabLines = buildTabLines(safeCtx.openTabs)
      lines.push('')
      lines.push(...tabLines)
    } else {
      // 明示「Space 内当前没打开任何 tab」——比省略字段更明确。
      lines.push('')
      lines.push('open_tabs: (none)')
    }
  }

  let text = lines.join('\n')
  if (text.length > budget) {
    text = text.slice(0, budget) + '\n[context truncated due to budget]'
  }

  return text
}

/**
 * 渲染 "用户当前焦点" 这一行（取代旧的 `focused_app:` + `Active app:` 两行重复）。
 *
 * 决策树：
 *  1. 有 active tab 且带 display_name → "focused: 多维表「营销表」" 或（首页）"focused: 多维表 (首页)"
 *  2. 无 active tab，ctx.appType === 'chat' → "focused: Chat Panel"
 *  3. 都没有 → 不输出（让 LLM 自行从 open_tabs 推断）
 */
function buildFocusedLine(ctx: AppContext): string | null {
  const activeTab = ctx.openTabs?.find((t) => t.active)
  if (activeTab) {
    return `focused: ${formatTabLabel(activeTab)}`
  }
  if (ctx.appType === 'chat') {
    return 'focused: Chat Panel（用户当前在对话面板上，没有聚焦到具体 App tab）'
  }
  return null
}

/**
 * 渲染单个 tab 的人话标签：
 *  - 首页 tab：    "多维表 (首页)"
 *  - 资源 tab：    "多维表「营销表」"
 *  - 缺标题资源：  "多维表「未命名」(id: ff35df32)"  ← ID 只在必要时短截
 *  - 无 display_name 时回退到 type（极端 fallback，正常路径不会触发）。
 */
function formatTabLabel(t: AppContextTab): string {
  const appName = t.display_name || t.app_key || t.type
  if (t.is_home) {
    return `${appName} (首页)`
  }
  if (t.title) {
    return `${appName}「${t.title}」`
  }
  // 资源 tab 但没标题——短截 id（取前 8 位）作为最弱的可辨识锚点。
  if (t.id) {
    const shortId = String(t.id).slice(0, 8)
    return `${appName}「未命名」(id: ${shortId})`
  }
  return appName
}

/**
 * 从 tab 上挑选最关键的 1-2 个 meta 字段（用于 background tabs 的紧凑显示）。
 * 设计原则：每个 tab 只带最能区分"它具体是哪个东西"的字段，避免 token 爆炸。
 */
function pickTabHints(t: AppContextTab): string[] {
  const hints: string[] = []
  if (t.url) hints.push(`url=${t.url}`)
  if (t.path) {
    // 路径通常很长，截断尾部最后两段（user 视觉认知够用）
    const segs = t.path.split('/').filter(Boolean)
    const tail = segs.length > 2 ? `…/${segs.slice(-2).join('/')}` : t.path
    hints.push(`path=${tail}`)
  }
  if (t.kind) hints.push(`kind=${t.kind}`)
  // R4.3：terminal tab 的 session_id 是它"具体是哪个终端"的唯一锚点。同 path 一样
  // 短截一下避免占 token——session id 后 8 位足够区分。
  if (t.session_id) {
    const shortSid = String(t.session_id).slice(-8)
    hints.push(`session=${shortSid}`)
  }
  return hints
}

function buildTabLines(tabs: AppContextTab[]): string[] {
  const lines: string[] = []
  const activeTab = tabs.find((t) => t.active)
  const backgroundTabs = tabs.filter((t) => !t.active)

  // active tab 已经在 buildFocusedLine 输出过——这里只列 background。但留一行 active
  // 在 open_tabs 列表顶部，让 Agent 一眼能看到「这一摞 tab 里哪个是焦点」。
  if (activeTab || backgroundTabs.length > 0) {
    lines.push('open_tabs:')
  }
  if (activeTab) {
    const hints = pickTabHints(activeTab)
    const hintStr = hints.length > 0 ? ` [${hints.join(', ')}]` : ''
    lines.push(`  - ${formatTabLabel(activeTab)}${hintStr} (active)`)
  }

  if (backgroundTabs.length > 0) {
    const MAX_BG = 5
    const visibleBg = backgroundTabs.slice(0, MAX_BG)
    if (visibleBg.length > 0) {
      for (const t of visibleBg) {
        const hints = pickTabHints(t)
        const hintStr = hints.length > 0 ? ` [${hints.join(', ')}]` : ''
        lines.push(`  - ${formatTabLabel(t)}${hintStr}`)
      }
      if (backgroundTabs.length > MAX_BG) {
        lines.push(`  - (+${backgroundTabs.length - MAX_BG} more tabs)`)
      }
    }
  }

  return lines
}
