/**
 * `@tabtin/agent-runtime/capability` —— Capability 总框架的 barrel export。
 *
 * 下游模块应这样 import：
 *
 *   import {
 *     Capability,
 *     CapabilityBase,
 *     BackendSession,
 *     BaseBackendSession,
 *     prepareAgentTools,
 *     // ...
 *   } from '@tabtin/agent-runtime/capability';
 *
 * 不要从 `@tabtin/agent-runtime/capability/capability.js` 等子路径直接
 * import —— 子路径不在 package.json exports 白名单中（避免对下游暴露
 * 内部文件结构）。
 *
 * **Capability 6 个 hook 一览**（详见 `capability.ts`）：
 *
 *   1. `required_capability_types?` —— 依赖声明（CapabilityRegistry 校验）
 *   2. `process_manifest?`         —— 工作区物料化变换（仅 LocalVM/Cloud）
 *   3. `bind?`                     —— 每轮 prepare_agent 时绑定 session
 *   4. `tools?`                    —— 贡献工具列表（Tool[]）
 *   5. `sampling_params?`          —— 贡献 / 调整模型采样参数
 *   6. `hooks?`                    —— 贡献 EngineHooks（runtime 生命周期）
 *
 *   生命周期辅助：`clone?` + `on_session_stop?`
 *
 *   **已下线**：原 hook 5 `instructions?(manifest?)`（阶段 2.3，2026-05-20），
 *   0 production caller，详见 `capability.ts` 顶部 docstring。
 *
 * **典型实施起点**：
 *   - 简单 cap：`class FooCap extends CapabilityBase { ... }` 然后实现
 *     需要的 hook（其他全 optional 不实现）。
 *   - Backend session：`class FooBackendSession extends BaseBackendSession`
 *     仅实现 6 个抽象方法（exec/read/write/running/persistWorkspace/hydrateWorkspace）
 *     即可获得 ls/mkdir/rm/exists/apply_patch/extract 默认实现。
 *
 * **冻结约定**（M1 §3 锚点接口）：本 barrel 导出的所有类型 / 类 /
 * 函数签名是冻结的。可加新成员，不能删 / 改语义。
 */

// ─── Types: Capability ──────────────────────────────────────────────
export type { Capability, CapabilityCategory } from './capability.js';

// ─── Types: Backend Session ─────────────────────────────────────────
export type {
  BackendSession,
  BackendType,
  BackendSessionCapabilities,
  AgentHomeLayout,
  ExecOptions,
  ExecResult,
  FileStat,
  InteractiveSession,
  PersistableSession,
  HibernatableSession,
  CloneableSession,
  SessionPersistState,
} from './backend-session.js';

// ─── Types: Manifest ────────────────────────────────────────────────
export type {
  Manifest,
  Entry,
  FileEntry,
  LocalFileEntry,
  DirEntry,
  LocalDirEntry,
  GitRepoEntry,
  MountEntry,
  Permissions,
  User,
  Group,
  PathGrant,
} from './manifest.js';

// ─── Classes ────────────────────────────────────────────────────────
export { CapabilityBase } from './base.js';
export { BaseBackendSession, shellEscape } from './base-backend-session.js';
export { CapabilityRegistry } from './registry.js';
export type {
  CapabilityFactory,
  CapabilityRegistryEntry,
} from './registry.js';

// ─── Functions: prepare ─────────────────────────────────────────────
// 阶段 2 (2026-05-20): 删除 prepareAgentInstructions / prepareAgentSampling 两套
// 装配函数（含常量 / 类型 / helper），原因均为 0 production caller —— 详见
// prepare.ts 顶部注释。当前 Capability 走 composeCapabilityHooks +
// prepareAgentTools 两件套即可装配进 EngineConfig。
export {
  composeCapabilityHooks,
  prepareAgentTools,
} from './prepare.js';
export type {
  PreparedTools,
} from './prepare.js';

// ─── Functions: hooks-compose ───────────────────────────────────────
// W2.2.3：`composeHooks(...hooks)` 是 EngineHooks 的通用合并工具，宿主
// 装配代码常用形态：`composeHooks(capHooks, ...host-side hooks)`。
// SSoT 在 capability/hooks-compose.ts；W2.3 删 middleware 整目录后，
// barrel 仅此一处对外暴露 composeHooks 给宿主一站式获取。
export { composeHooks } from '../engine/core/hooks-compose.js';

// ─── Errors ─────────────────────────────────────────────────────────
export {
  CapabilityDependencyError,
  CapabilityToolsConflictError,
  CapabilityToolNameError,
  SessionPersistStateVersionError,
} from './errors.js';

// ─── Core 三件套（W2.2.1）────────────────────────────────────────────
// 通用基础设施 Capability：FileSystem / Shell / Skills。每个 Capability
// 都 extends CapabilityBase 并实现 7 hook 中需要的部分，详见
// `core/filesystem.ts` / `core/shell.ts` / `core/skills.ts`。
export {
  FileSystemCap,
  type FilesystemCapConfig,
  PlatformDataCap,
  type PlatformDataCapConfig,
  RawRefCap,
  type RawRefCapConfig,
  ShellCap,
  type ShellCapConfig,
} from './core/index.js';

// ─── ：平台目录类 Cap 的共享召回基础设施 ────────────────────
// CliCap / SkillsCap / McpCap 本体已迁出 core（宿主平台 Cap 层），
// 但它们共用的召回检索词构造（`buildRecallQuery`）与动态段描述去重
// （`collectDescribedKeys` / `blankSeenDescriptions`）属共享基础设施 ——
// 分别耦合 `todo/todo-replay`（非公开）与 engine conversation markers。
// 留在 agent-runtime 作为 SSoT，由 host 侧 Cap 跨包 import，避免把这些
// 引擎内部经公共面外泄。
export { buildRecallQuery } from './core/message-query.js';
export {
  collectDescribedKeys,
  blankSeenDescriptions,
} from './core/relevant-seen.js';

// ─── ShellCap W2.3 扩展契约（独立验证 P0-1 / P0-3）────────────────
// SkillContextProvider 让宿主装配时把 Skill 凭据注入回调（Electron /
// Daemon 各自包装 createSkillCredentialResolver）传给 ShellCap，是
// "宿主层注入回调避免 agent-runtime 反向耦合宿主"模式（已退役的
// TabDocCap dispatcher 也走过同一模式）。
//
// 不从 `core/index.ts` 加是因为 `core/index.ts` 是 W2.2.1 已落地冻结
// 文件——本 barrel 走顶层 capability/* 子路径直 export 即可（与
// 其它装配 helper 同模式）。
export type {
  ShellCapInit,
  HardlineCommandChecker,
  HardlineCommandHit,
  ShellPresentationResolver,
  SkillContextProvider,
  SkillCredentialInjection,
} from './core/shell.js';

// ─── L16 W5.5：受限模式 shell input 级白名单 ──────────────────────
// 让宿主能 import checker 工厂 + 类型，按 agentMode 决定是否注入到 ShellCapInit。
export {
  createTabtinReadonlyChecker,
  buildRiskMapFromSchemas,
  parseTabtinCommandsJson,
  tokenizeShellCommand,
} from './core/restricted-shell-allowlist.js';
export type {
  CliCommandSchema,
  RestrictedShellAllowlistChecker,
  ShellAllowlistDecision,
  FetchCommandRisk,
} from './core/restricted-shell-allowlist.js';

// ─── App Cap（暂无）──────────────────────────────────────────────
// 内置 App 的 Agent 侧入口 Capability。历史上有 `TabDataCap`（Wave 4a 退役，
// 2026-05-01）和 `TabDocCap`（Wave 12 退役，2026-05-04）——产品方向都是
// "Agent 主要靠 CLI（`tabtin table *` / `tabtin doc *`）操作内置 App，不依
// 赖 FC"。当前 `capability/app/` 暂无可导出的 Cap；如未来需要新的 App Cap
// （例如 TabMemoCap），新文件挂在 `app/<cap>.ts`，从本 barrel re-export。

// ─── Governance 两件套（W2.2.3）────────────────────────────────────
// 横切治理 Capability：Audit / Cost。AuditCap 是 hooks-only 模板（tools
// 空 + 6 hook 流向 writer）；CostCap 是全生命周期 hooks 模板（合并
// BudgetTracker + token-budget + context-pressure）。
// 详见 `governance/audit.ts` / `governance/cost.ts`。
export {
  AuditCap,
  AUDIT_CAP_STREAM_EVENT_TYPE,
  createRelayAuditWriter,
  type AuditCapInit,
  type AuditEvent,
  type AuditLevel,
  type AuditWriter,
  CostCap,
  calculateTokenWarningState,
  DEFAULT_MAX_CREDITS_PER_RUN,
  type CostCapConfig,
  type CostCapExecutionLimits,
  type CostCapInit,
  type PressureLevel,
  type TokenWarningState,
} from './governance/index.js';
