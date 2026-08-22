/**
 * ：host 侧 agent 工具包装——模板展开 + 交付物 enrich。
 *
 * runtime `createAgentTool` 只处理通用子 run 协议；Space 模板解析与交付物
 * 收集在本模块完成后再调用 inner tool。
 *
 * persona 必须冻结进**本次** spawn 的 AgentToolConfig（闭包常量），
 * 不能用共享可变 overrides：后台子在 onStarted 后异步开跑，外层 execute 早已返回。
 */

import {
  createAgentTool,
  StreamEvents,
  type AgentToolConfig,
  type SystemPromptProvider,
  type Tool,
  type ToolContext,
  type ToolResult,
} from '@tabtin/agent-runtime'
import type { SessionConfig } from '@tabtin/agent-runtime/engine'
import {
  appendDeliverablesToToolResultContent,
  type ChildDeliverable,
} from '../delivery/child-deliverables.js'
import {
  collectDeliverablesForChild,
  type ChildDeliverablesEnricherDeps,
} from '../delivery/child-deliverables-enrichment.js'
import { expandTemplateIntoAgentInput } from './expand-template-input.js'
import type { TemplateSnapshotsGetter } from './subagent-template-resolver.js'

export interface HostAgentToolDeps extends ChildDeliverablesEnricherDeps {
  getTemplateSnapshots: TemplateSnapshotsGetter
}

interface DeferredSubagentCompleted {
  event: Parameters<NonNullable<ToolContext['emitStreamEvent']>>[0]
  childId: string
  summary: string
}

function normalizeAgentIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean),
  )].sort()
}

function readToolInput(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null
    ? input as Record<string, unknown>
    : {}
}

function resolveParentToolNames(config: AgentToolConfig): string[] {
  return config.tools.getTools().map((tool) => tool.name)
}

/** 与 runtime string fallback 对齐：无宿主 provider 时剥离编排段再注入 persona。 */
function stripSubagentOrchestrationSections(parentPrompt: string): string {
  let out = parentPrompt
  out = out.replace(/<subagent_orchestration>[\s\S]*?<\/subagent_orchestration>/, '')
  out = out.replace(/<subagent_catalog>[\s\S]*?<\/subagent_catalog>/, '')
  return out.replace(/\n{3,}/g, '\n\n').trim()
}

function wrapSystemPromptProvider(
  base: SystemPromptProvider | undefined,
  personaPrompt: string | undefined,
): SystemPromptProvider {
  const persona = personaPrompt?.trim() || undefined
  return {
    resolveSubagentPrompt(input) {
      const resolved = base
        ? base.resolveSubagentPrompt(input)
        : stripSubagentOrchestrationSections(input.parentPrompt)
      if (!persona) return resolved
      return `${resolved}\n\n<subagent_persona>\n${persona}\n</subagent_persona>`
    },
  }
}

/** 为单次 spawn 冻结 persona，供前台与后台子异步开跑共用。 */
function buildFrozenSpawnConfig(
  config: AgentToolConfig,
  overrides: { personaPrompt?: string },
): AgentToolConfig {
  return {
    ...config,
    systemPromptProvider: wrapSystemPromptProvider(
      config.systemPromptProvider,
      overrides.personaPrompt,
    ),
  }
}

async function emitCompletedWithDeliverables(
  event: DeferredSubagentCompleted['event'],
  childId: string,
  parentEmit: ToolContext['emitStreamEvent'],
  deps: HostAgentToolDeps,
): Promise<ChildDeliverable[]> {
  const deliverables = await collectDeliverablesForChild(deps, childId)
  parentEmit?.({
    ...event,
    payload: {
      ...(event.payload ?? {}),
      ...(deliverables.length > 0 ? { deliverables } : {}),
    },
  })
  return deliverables
}

async function flushDeferredSubagentCompletedEvents(
  deferred: DeferredSubagentCompleted[],
  parentEmit: ToolContext['emitStreamEvent'],
  deps: HostAgentToolDeps,
): Promise<Map<string, ChildDeliverable[]>> {
  const deliverablesByChild = new Map<string, ChildDeliverable[]>()
  for (const item of deferred) {
    const deliverables = await emitCompletedWithDeliverables(
      item.event,
      item.childId,
      parentEmit,
      deps,
    )
    if (deliverables.length > 0) {
      deliverablesByChild.set(item.childId, deliverables)
    }
  }
  return deliverablesByChild
}

function enrichForegroundToolResult(
  result: ToolResult,
  deferred: DeferredSubagentCompleted[],
  deliverablesByChild: Map<string, ChildDeliverable[]>,
): ToolResult {
  if (typeof result.content !== 'string' || deferred.length !== 1) return result
  const item = deferred[0]
  const deliverables = deliverablesByChild.get(item.childId)
  if (!deliverables?.length || !item.summary) return result
  const summaryIndex = result.content.indexOf(item.summary)
  if (summaryIndex < 0) return result
  const enrichedSummary = appendDeliverablesToToolResultContent(item.summary, deliverables)
  return {
    ...result,
    content:
      result.content.slice(0, summaryIndex)
      + enrichedSummary
      + result.content.slice(summaryIndex + item.summary.length),
  }
}

function isSubagentWaitPresentation(result: ToolResult): boolean {
  return result.presentation?.kind === 'subagent_wait'
}

/** wait 路径：按 childId 追加交付物段，不依赖 runtime 终态快照 API。 */
async function enrichWaitToolResult(
  result: ToolResult,
  childIds: string[],
  deps: HostAgentToolDeps,
): Promise<ToolResult> {
  if (typeof result.content !== 'string' || !isSubagentWaitPresentation(result)) {
    return result
  }
  if (childIds.length === 0) return result

  const chunks: string[] = []
  for (const childId of childIds) {
    const deliverables = await collectDeliverablesForChild(deps, childId)
    if (deliverables.length === 0) continue
    chunks.push(appendDeliverablesToToolResultContent(
      `子 Agent ${childId.slice(0, 8)}`,
      deliverables,
    ))
  }
  if (chunks.length === 0) return result
  return {
    ...result,
    content: `${result.content}\n${chunks.join('\n')}`,
  }
}

/** 包装 runtime agent 工具：模板展开 + 前台/等待路径交付物 enrich。 */
export function createHostAgentTool(
  config: AgentToolConfig,
  deps: HostAgentToolDeps,
): Tool {
  const prototype = createAgentTool(config)

  return {
    ...prototype,
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const raw = readToolInput(input)
      const waitAgentIds = normalizeAgentIdList(raw.wait_agent_ids)
      const parentEmit = context.emitStreamEvent
      const deferredCompleted: DeferredSubagentCompleted[] = []
      let executeSettled = false

      const expanded = await expandTemplateIntoAgentInput(
        input,
        deps.getTemplateSnapshots,
        resolveParentToolNames(config),
      )

      // check / wait 复用 prototype，保留 createAgentTool 闭包内的 check_agent_id 冷却节流。
      // 仅派活且需要 persona 时新建冻结 config 的 tool（后台异步开跑也不丢侧信道）。
      const checkAgentId = typeof raw.check_agent_id === 'string'
        ? raw.check_agent_id.trim()
        : ''
      const needsFrozenSpawn = waitAgentIds.length === 0
        && !checkAgentId
        && Boolean(expanded.personaPrompt)
      const inner = needsFrozenSpawn
        ? createAgentTool(buildFrozenSpawnConfig(config, {
          personaPrompt: expanded.personaPrompt,
        }))
        : prototype

      const wrappedContext: ToolContext = waitAgentIds.length > 0 || checkAgentId
        ? context
        : {
            ...context,
            emitStreamEvent: (event) => {
              if (event.type === StreamEvents.SUBAGENT_COMPLETED) {
                const payload = event.payload ?? {}
                const childId = typeof payload.subagent_run_id === 'string'
                  ? payload.subagent_run_id
                  : ''
                const summary = typeof payload.summary === 'string' ? payload.summary : ''
                if (childId) {
                  if (!executeSettled) {
                    deferredCompleted.push({ event, childId, summary })
                    return
                  }
                  void emitCompletedWithDeliverables(event, childId, parentEmit, deps)
                  return
                }
              }
              parentEmit?.(event)
            },
          }

      const result = await inner.execute(expanded.input, wrappedContext)
      executeSettled = true

      if (waitAgentIds.length > 0) {
        return enrichWaitToolResult(result, waitAgentIds, deps)
      }

      const deliverablesByChild = await flushDeferredSubagentCompletedEvents(
        deferredCompleted,
        parentEmit,
        deps,
      )
      return enrichForegroundToolResult(result, deferredCompleted, deliverablesByChild)
    },
  }
}

export type { SessionConfig }
