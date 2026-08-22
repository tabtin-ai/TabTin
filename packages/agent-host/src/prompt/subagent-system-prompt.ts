/**
 * 子 Agent system prompt 重烘焙（从 agent-runtime/subagent-readonly 迁出，
 *  Stage 2b）。
 */

import { getAgentModePromptSection } from '@tabtin/agent-modes'
import {
  buildSystemPrompt,
  SECTION_SUBAGENT_ORCHESTRATION,
  type SystemPromptConfig,
} from '@tabtin/agent-prompt'
import type {
  ResolveSubagentPromptInput,
  SystemPromptProvider,
  SystemPromptToolRef,
} from '@tabtin/agent-runtime/engine'

/**
 * 把父 Agent 的 system prompt 重烘焙成子 Agent 的执行者视角。
 *
 * **动机**：子 Agent 的 base prompt 继承自父。群模式下父 prompt 含 group.md
 * 「你是项目管理者」+ `<subagent_catalog>`——若原样下发，子 Agent 会把自己
 * 当成主代理去派活。子 Agent 只应是执行者（`'agent'`）或只读研究者（`'ask'`）。
 *
 * 优先用宿主原始 `buildConfig` 按目标 `mode` 重烘焙；宿主未透传时退化为
 * 字符串处理：换 `<agent_mode>` 段并剥掉 `<subagent_catalog>`。
 */
export function resolveSubagentSystemPrompt(
  parentPrompt: string,
  buildConfig: SystemPromptConfig | undefined,
  mode: 'ask' | 'agent',
  childTools?: ReadonlyArray<SystemPromptToolRef>,
): string {
  if (buildConfig) {
    return buildSystemPrompt({
      ...buildConfig,
      agentMode: mode,
      // worker 视角：不注入静态段末尾的 <subagent_orchestration>
      subagentWorker: true,
      tools: childTools?.map((t) => ({
        name: t.name,
        description: t.description ?? '',
      })) ?? buildConfig.tools,
    })
  }

  let out = parentPrompt
  out = out.replace(SECTION_SUBAGENT_ORCHESTRATION, '')
  const targetSection = getAgentModePromptSection(mode)
  const agentModeBlock = /<agent_mode>[\s\S]*?<\/agent_mode>/
  if (targetSection) {
    out = agentModeBlock.test(out)
      ? out.replace(agentModeBlock, targetSection.trim())
      : `${out}\n\n${targetSection}`
  } else if (agentModeBlock.test(out)) {
    out = out.replace(agentModeBlock, '')
  }
  out = out.replace(/<subagent_catalog>[\s\S]*?<\/subagent_catalog>/, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

export function resolveReadonlySubagentSystemPrompt(
  parentPrompt: string,
  buildConfig: SystemPromptConfig | undefined,
  childTools?: ReadonlyArray<SystemPromptToolRef>,
): string {
  return resolveSubagentSystemPrompt(parentPrompt, buildConfig, 'ask', childTools)
}

function isSystemPromptConfig(value: unknown): value is SystemPromptConfig {
  return typeof value === 'object' && value !== null
}

/** runtime 传入的 opaque mode → 子 Agent 仅 ask / agent 两态。 */
function resolveChildPromptMode(mode: string): 'ask' | 'agent' {
  return mode === 'ask' ? 'ask' : 'agent'
}

/** 默认 SystemPromptProvider：包装 host 侧 resolveSubagentSystemPrompt。 */
export function createSystemPromptProvider(): SystemPromptProvider {
  return {
    resolveSubagentPrompt(input: ResolveSubagentPromptInput): string {
      const buildConfig = isSystemPromptConfig(input.buildConfig)
        ? input.buildConfig
        : undefined
      return resolveSubagentSystemPrompt(
        input.parentPrompt,
        buildConfig,
        resolveChildPromptMode(input.mode),
        input.childTools,
      )
    },
  }
}
