export {
  createHostRuntimeOptions,
  daemonHostRuntimeOptions,
  decodeAttachmentStrategyFromPayload,
  electronHostRuntimeOptions,
  type AttachmentStrategy,
  type DoomLoopPolicy,
  type HostRuntimeOptions,
  type HostRuntimeOptionsLogger,
  type HostRuntimeProfile,
} from './host-runtime-options.js'
//  / ：Space SubAgentTemplate 解析 + host agent 工具包装。
export {
  createHostAgentTool,
  type HostAgentToolDeps,
} from './host-agent-tool.js'
export { createSubagentToolProvider } from './subagent-tool-provider.js'
export { expandTemplateIntoAgentInput } from './expand-template-input.js'
export {
  mapRawTemplateToSnapshot,
  resolveTemplateSpawn,
  type SubAgentTemplateSnapshot,
  type TemplateSnapshotsGetter,
  type TemplateSpawnResolution,
} from './subagent-template-resolver.js'
