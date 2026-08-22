export {
  createCoreTools,
  type CoreToolsDeps,
} from './core-tools.js'
export {
  createAskTools,
  type AskToolsDeps,
} from './ask-tools.js'
export type { SkillCredentialResolver, SkillCredentialInjection } from './skill-credential-types.js'
export { joinApiPath } from '../utils/api-url.js'
export { createWebTools, type WebToolsDeps } from './web-tools.js'
export {
  createProjectTaskTools,
  type ProjectTaskToolsDeps,
} from './project-task-tools.js'
// W3 (2026-05-10): `context-tools.ts` deleted along with the
// `retrieve_tool_result` and `summarize_context` self-invented tools.
// Large outputs are now routed via `<persisted-output>` + `read_file`
// (see `tool-orchestration.ts` / `tool-result-storage.ts`); LLM-driven
// condensation is replaced by runtime auto-compact in
// `compact/compaction-orchestrator.ts`.
export { createPresentationTools, type PresentationToolsDeps } from './presentation-tools.js'
export {
  createShowWidgetTool,
  SHOW_WIDGET_TOOL_NAME,
  type ShowWidgetToolDeps,
  type BakeAndUploadFn,
  type BakeAndUploadResult,
  type BakeWidgetInput,
} from './show-widget.js'
/** @deprecated 仅保留公开 API 兼容；不得注册到 Agent Chat 默认工具集。 */
export { createShowFlowViewTool, SHOW_FLOW_VIEW_TOOL_NAME } from './show-flow-view.js'
// data-tools / document-tools 已迁宿主业务工具包。这里公开
// 工具层错误口径（jsonError / 后端错误翻译 / error-kind 常量）供宿主侧业务工具复用，
// 保持工具错误契约单一真源在 runtime。
export { jsonError } from '../capability/core/_utils.js'
export { toJsonErrorMetadata, translateBackendError } from './_backend-error-translator.js'
export {
  AUTH_FAILED,
  INVALID_PARAM_FORMAT,
  MISSING_REQUIRED_PARAM,
  NETWORK_FAILED,
  PERMISSION_DENIED,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  RESOURCE_NOT_FOUND,
  RUNTIME_MISCONFIG,
  UPSTREAM_ERROR,
  DOCUMENT_NOT_READY,
  TOOL_STALE_READ,
  OLD_STRING_NOT_FOUND,
  OLD_STRING_NOT_UNIQUE,
  FILE_NOT_FOUND,
  FILE_TOO_LARGE,
  ENCRYPTED,
  CORRUPTED,
  SCANNED_PDF,
  GARBLED_TEXT_LAYER,
  UNSUPPORTED_FORMAT,
  PARSE_TIMEOUT,
  IMAGE_RESIZE_FAILED,
} from '../engine/errors/error-kinds.js'
export type { ToolErrorKind } from '../engine/errors/error-kinds.js'
// 项目规则自动加载（AGENTS.md MVP）：读盘 helper，仿 memory 搜索范式
// 经 `@tabtin/agent-runtime/tools` 暴露给两端宿主装配 rules-injector hook 时用。
// （`__resetProjectRulesCacheForTests` 不进公共 barrel——测试直接深 import
// `./project-rules.js`，与 callMemorySearchAPI 一样保持公共面只暴露生产 API。）
export {
  readProjectRules,
  type ReadProjectRulesOptions,
} from './project-rules.js'
export {
  createSwitchModeTool,
  REQUIRES_CLIENT_APPROVAL,
  ALREADY_PENDING,
  type SwitchModeToolDeps,
  type SwitchModeToolInput,
  type SwitchModeProposalRegistry,
} from './mode-tools.js';
export {
  createPlanTools,
  type PlanToolsDeps,
  type PlanCreateToolInput,
  type PlanUpdateTodosToolInput,
  type PlanTodoInput,
  type PlanPhaseInput,
} from './plan-tools.js'
export {
  createSkillsTools,
  SKILLS_UNSUPPORTED_PREFIX_MESSAGE,
  buildSkillAvailabilityError,
  skillAvailabilityErrorKind,
  skillUnavailableMessage,
  skillUnavailableHint,
  type SkillsToolsDeps,
  type SkillsToolsCallbackContext,
  type SkillRecord,
} from './skills-tools.js'
export {
  createSkillActivation,
  type SkillInvokeDeps,
} from '../skills/skill-activation.js'
export {
  createSkillCreateTool,
  type SkillCreateDeps,
} from './skill-create-tool.js'
export {
  createPersonalPluginRuntimeTool,
  type PersonalPluginRuntimeToolDeps,
  type PersonalPluginLaunchRuntimeInput,
  type PersonalPluginLaunchRuntimeStatus,
} from './personal-plugin-runtime-tool.js'
export {
  createSystemTools,
  type SystemToolsDeps,
} from './system-tools.js'
// tabcode-adapter / read-file-state / binary-dedup-state 已迁宿主业务工具包
// （ Stage 1.5）。createTabCodeTools 与相关 helper 由宿主侧 tools
// 出口提供；dedup Map 类型契约见本包 ImageReadFileState / LocalDocReadFileState。
