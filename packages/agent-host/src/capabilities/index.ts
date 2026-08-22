/**
 * `@tabtin/agent-host/capabilities` —— 平台目录类 Capability barrel。
 *
 * CliCap / SkillsCap / McpCap 是「平台目录类」能力：把 tabtin CLI 命令树、
 * 已装 Skill、已挂载 MCP server 的清单注入 Agent 上下文（两区机制：静态段可缓存
 * 名称索引 + 动态段随 query 召回）。它们与具体宿主装配紧耦合（fetcher 由宿主注入），
 * 故从 `@tabtin/agent-runtime` 的通用 capability/core 迁到共享宿主包 `@tabtin/agent-host`。
 *
 * agent-runtime 的 capability/core 只保留真正通用的能力（filesystem / shell 等）；
 * 本模块经 `@tabtin/agent-runtime` 单向跨包 import 其 `CapabilityBase` /
 * 引擎契约 / 召回 helper / skills 子系统。两宿主（electron / daemon）装配时从
 * `@tabtin/agent-host/capabilities` import 这三个 Cap。
 */

export {
  CliCap,
  type CliCapInit,
  type CliCapFetcher,
  type CliListing,
  type CliCommandInfo,
} from './cli.js';

export {
  SkillsCap,
  type SkillsCapInit,
  type SkillsCapFetcher,
} from './skills.js';

export {
  McpCap,
  type McpCapInit,
  type McpCapFetcher,
  type McpListing,
  type McpServerInfo,
  type McpToolInfo,
} from './mcp.js';

export { MEDIA_IMAGE_CLI_INSTRUCTION } from './media-image.js';
export { resolveCliToolPresentation } from './cli-presentation.js';

// ：show_widget 烤图（offscreen 渲染 + OSS 上传，直连 @tabtin/action-tools）
// 从 agent-runtime 迁到此处，经 PresentationToolsDeps.bakeAndUpload 注入（core 去业务化）。
export { bakeAndUploadWidget } from './widget-bake.js';

// ：受限 shell / 不可信输出的 TabTin 业务判定（只读动词表 / Plan 浏览器
// 导航豁免 / tabtin fetch|browser untrusted 判定），从 agent-runtime 迁出，两宿主注入。
export {
  RESTRICTED_READONLY_VERBS,
  RESTRICTED_BROWSER_NAV_ALLOWLIST,
  isUntrustedShellCommand,
} from './shell-restriction.js';

// ：TabTin 临时隐藏 skill 名单（tabvideo）——产品运营决策，从 agent-runtime
// 迁出，经 initSkillsModule({ hiddenSkills }) 注入。
export { TEMPORARILY_HIDDEN_SKILLS } from './hidden-skills.js';

// ：present_to_user 的 TabTin 资源类型与 slide 禁自动打开策略，从
// agent-runtime 迁出，经 PresentationToolsDeps 注入。
export {
  PRESENT_SUPPORTED_RESOURCE_TYPES,
  presentAutoOpenPolicy,
} from './present-resources.js';

// ：本地文件产物的 tabtin:// 资源 URI 构造，从 agent-runtime
// 本地文件 artifact URL 构造由 present_to_user local_file item 注入。
export { buildLocalFileArtifactUrl } from './artifact-uri.js';
