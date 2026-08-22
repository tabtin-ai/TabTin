/**
 * `@tabtin/agent-runtime/capability/core` —— Core 三件套 Capability barrel。
 *
 * **Core 范畴**（capability.ts 的 CapabilityCategory 注释）：
 * - 通用 / 元能力基础设施（FileSystem / Shell / Skills / Cost 等）
 * - 与"操作领域对象（表 / 文 / 视频）"的 App 类区分；与"横切约束
 *   （审批 / 审计 / 预算）"的 governance 类区分
 *
 * **W2.2.1 落地的三件套**：
 * - `FileSystemCap`：目录工具（list_directory / mkdir）；文件读写删由 TabCode adapter/action-tools 承担
 * - `ShellCap`：1 件 `run_terminal_command`
 * - `SkillsCap`：2 件 `skills_search` / `skills_read` + 动态 `<skills>`
 *   prompt 注入（hooks().beforeIteration）
 *
 * **W2.2.2 / W2.2.3 范围**：再加 `CostCap`（governance 类，但暴露
 * usage 工具）等 —— 本 barrel 只 re-export 已实现项。
 */

export {
  FileSystemCap,
  type FilesystemCapConfig,
} from './filesystem.js';

export {
  RawRefCap,
  type RawRefCapConfig,
} from './raw-ref.js';

export {
  PlatformDataCap,
  type PlatformDataCapConfig,
} from './platform-data.js';

export {
  ShellCap,
  type ShellCapConfig,
  type ShellCapInit,
  type HardlineCommandChecker,
  type HardlineCommandHit,
  type ShellPresentationResolver,
  type SkillContextProvider,
  type SkillCredentialInjection,
} from './shell.js';

export {
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  DEDUP_WINDOW_MS,
  SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER,
  detectUnquotedWorkspacePath,
  resolveAgentShellInfo,
  type AgentCommandRequest,
  type AgentCommandProgressSnapshot,
  type AgentKillSignal,
  type AgentReadOptions,
  type AgentReadResult,
  type AgentShellInfo,
  type AgentShellKind,
  type AgentSpawnDetachedResult,
  type PtyManagerBridge,
  type ShellManagedTaskRecord,
  type ShellManagedTaskStorePort,
  type UnquotedWorkspacePathHit,
} from './shell-bridge-contract.js';

export {
  createTabtinReadonlyChecker,
  buildRiskMapFromSchemas,
  parseTabtinCommandsJson,
  tokenizeShellCommand,
  type CliCommandSchema,
  type RestrictedShellAllowlistChecker,
  type ShellAllowlistDecision,
  type FetchCommandRisk,
} from './restricted-shell-allowlist.js';

// ：SkillsCap / McpCap / CliCap（平台目录类 Cap）已整体迁到
// 宿主平台 Cap 层——agent-runtime 的 core 只保留真正通用的
// 能力（filesystem / shell 等）。它们共用的召回 helper（message-query /
// relevant-seen）仍留在本目录，由 `capability/index.ts` 对外导出供 host 跨包
// import。
