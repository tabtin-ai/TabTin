/**
 * `@tabtin/agent-host/hooks` —— 宿主侧「上下文贡献」EngineHooks 工厂集合。
 *
 * **背景（ Phase 1）**：把 agent-runtime 做成对 @tabtin/* 零依赖的通用
 * ReAct 引擎。引擎只保留 `EngineHooks`（context 变换钩子）作为唯一注入原语；
 * 原来住在 runtime `capability/injectors/` 的 6 段上下文贡献（context / memory /
 * mode-reminder / todo-state / rules / lsp-diagnostic）+ relevant-recall，
 * 全部迁到这里成为普通 host 钩子工厂 `(options) => EngineHooks`。共用逻辑退化为
 * `message-inject.ts` 两个纯函数（`upsertTaggedBlock` / `removeTaggedBlock`），
 * **不再有 `SingleBlockInjector` 基类或任何 Injector 类层级**。
 *
 * 宿主装配（Electron / Daemon runtime-assembly）用 `composeHooks(...)` 把这些 hook
 * 串进 EngineConfig.hooks。
 */

// ─── 共用原语 ────────────────────────────────────────────────────────
export {
  upsertTaggedBlock,
  removeTaggedBlock,
  type InjectPosition,
} from './message-inject.js'

// ─── context hook（Tab/App 环境快照）─────────────────────────────────
export {
  buildContextHook,
  getFocusedAppKey,
  type ContextHookOptions,
  type AppContext,
  type AppContextTab,
  type AppMetaFormatter,
} from './context-hook.js'

// ─── memory hook（TabMemo 跨会话召回）────────────────────────────────
export {
  buildMemoryHook,
  type MemoryHookOptions,
  type MemoryRecallSummary,
} from './memory-hook.js'

// ─── agent-profile hook（当前 Agent 名称 / 目标，贴用户消息前）────────
export {
  buildAgentProfileHook,
  type AgentProfileHookOptions,
  type AgentProfileSnapshot,
} from './agent-profile-hook.js'

// ─── mode-reminder hook（sparse mode reminder + transition）───────────
export {
  buildModeReminderHook,
  shouldInjectModeReminderThisTurn,
  type ModeReminderHookOptions,
  type PendingModeTransition,
} from './mode-reminder-hook.js'

// ─── todo-state hook（活跃待办快照）──────────────────────────────────
export {
  buildTodoStateHook,
  type TodoStateHookOptions,
} from './todo-state-hook.js'

// ─── rules hook（AGENTS.md 项目规约）─────────────────────────────────
export {
  buildRulesHook,
  type RulesHookOptions,
} from './rules-hook.js'

// ─── lsp-diagnostic hook（LSP 诊断 attachment）──────────────────────
export {
  buildLspDiagnosticHook,
  type LspDiagnosticHookOptions,
} from './lsp-diagnostic-hook.js'

// ─── relevant-recall hook（`<relevant_*>` 每轮召回）─────────────────
export {
  buildRelevantRecallHook,
  type RelevantRecallHookOptions,
} from './relevant-recall-hook.js'

// ─── TabTin 对话 worktree CLI 路由（code/mixed 静态 system policy）────
export {
  buildWorktreeRoutingHook,
  type WorktreeRoutingHookOptions,
} from './worktree-routing-hook.js'

// ─── Project Task runtime anchor（条件 system context）────────────────
export {
  buildProjectTaskContextHook,
  resolveProjectTaskRuntimeContext,
  type ProjectTaskContextHookOptions,
  type ProjectTaskRuntimeContext,
} from './project-task-context-hook.js'
