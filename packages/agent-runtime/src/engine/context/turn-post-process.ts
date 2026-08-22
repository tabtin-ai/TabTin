/**
 * 每轮后处理：compaction 强制阈值标记、工具结果 side-effects（注入消息 → USER
 * 事件 / state 覆盖 / agent mode 热切换重建工具与 prompt）、注入后 & 轮末上下文压力
 * 重算、environment context 文本提取。自 query.ts 抽出。
 */
import { UserEvent } from '../../event/events/user-events.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import { estimateFullContextTokens } from './token-budget.js';
import { buildUserEventBlocks } from './user-message.js';
import { buildToolParams } from '../tooling/tool-params.js';
import { flattenSystemPrompt } from './system-prompt-text.js';
import {
  applySkillStateOverrides,
  buildModelOverrideNotice,
  extractInjectedText,
} from '../core/runtime-helpers.js';
import { nextArrivalSeq } from '../../event/event-emitter.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../runtime-defaults.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from '../contracts/conversation.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../contracts/context-capability.js';
import type {
  StreamEvent,
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import type {
  Message,
  SystemBlock,
  ToolParam,
} from '../contracts/conversation.js';
import type {
  Tool,
  ToolResult,
} from '../contracts/tools.js';
import type {
  EngineConfig,
  EngineState,
  QueryDeps,
} from '../contracts/kernel.js';
import type { TokenEstimator } from './token-budget.js';
import type { ToolExecutionResult } from '../tooling/tool-orchestration.js';
import type { ToolRegistry } from '../tooling/tool-system.js';

export function markCompactionForceIfNeeded(args: {
  state: EngineState;
  toolParams: ToolParam[];
  tokenEstimator: TokenEstimator;
  config: EngineConfig;
  budget: typeof DEFAULT_CONTEXT_BUDGET;
}): void {
  const outputReserve = args.config.maxOutputTokens ?? 16_384;
  const resolvedWindow = args.config.resolveContextWindow?.(args.state.model)
    ?? args.config.contextWindowTokens ?? 200_000;
  const effectiveWindow = Math.max(1, resolvedWindow - outputReserve);
  const restoredTokens = estimateFullContextTokens(
    args.state.messages,
    args.state.systemPrompt,
    args.toolParams,
    undefined,
    args.tokenEstimator,
  );
  if (restoredTokens / effectiveWindow >= args.budget.compactThreshold) {
    args.state._compactionForce = true;
  }
}

function* emitToolInjectedMessages(args: {
  messages: Message[];
  deps: QueryDeps;
  toolUseId: string;
}): Generator<StreamEvent, void, undefined> {
  for (const msg of args.messages) {
    const textContent = extractInjectedText(msg);
    const inputBlocks = typeof msg.content === 'string' ? undefined : msg.content;
    const blocks = buildUserEventBlocks(textContent, inputBlocks);
    if (!blocks) continue;
    yield new UserEvent({
      client_event_id: args.deps.generateUUID(),
      content: textContent,
      source: isToolInjectedMessage(msg) ? 'tool_injected' : 'skill_invoke',
      tool_call_id: args.toolUseId,
      blocks_json: blocks,
      arrival_seq: nextArrivalSeq(),
    }).toStreamEvent();
  }
}

function isToolInjectedMessage(message: Message): boolean {
  return typeof message.content !== 'string'
    && message.content.some((block) => block.type !== 'text');
}

export async function applyModeOverride(args: {
  mod: NonNullable<ToolResult['contextModifier']>;
  config: EngineConfig;
  toolParams: ToolParam[];
  toolMap: Map<string, Tool>;
  staticToolNames: Set<string>;
  toolRegistry: ToolRegistry;
  state: EngineState;
  systemPromptRawRef: { current: string | SystemBlock[] | undefined };
}): Promise<SystemNoticeEvent | null> {
  if (!args.mod.modeOverride) return null;
  const newBase = args.config.tools.getTools();
  args.toolParams.length = 0;
  args.toolParams.push(...buildToolParams(newBase));
  args.toolMap.clear();
  for (const t of newBase) args.toolMap.set(t.name, t);
  args.staticToolNames.clear();
  for (const t of newBase) args.staticToolNames.add(t.name);
  await args.toolRegistry.refreshTools(args.config.tools);
  args.systemPromptRawRef.current = args.config.systemPrompt;
  args.state.systemPrompt = flattenSystemPrompt(args.config.systemPrompt);
  return new RuntimeSystemNoticeEvent({
      content: `Agent mode switched to ${args.mod.modeOverride}`,
      notice_type: 'mode_override',
      mode: args.mod.modeOverride,
  }).toStreamEvent();
}

export async function* applyToolResultSideEffects(args: {
  executionResults: ToolExecutionResult[];
  state: EngineState;
  deps: QueryDeps;
  tokenEstimator: TokenEstimator;
  config: EngineConfig;
  toolParams: ToolParam[];
  toolMap: Map<string, Tool>;
  staticToolNames: Set<string>;
  toolRegistry: ToolRegistry;
  systemPromptRawRef: { current: string | SystemBlock[] | undefined };
  activeSkillRef: { current: { skillKey: string; primaryEnv?: string } | null };
}): AsyncGenerator<StreamEvent, boolean, undefined> {
  let hasInjectedMessages = false;
  for (const er of args.executionResults) {
    if (er.result.newMessages?.length) {
      const newMessages = er.result.newMessages.map((message) =>
        isToolInjectedMessage(message)
          ? setInternalMarker({ ...message }, INTERNAL_MESSAGE_MARKERS.TOOL_INJECTED)
          : message,
      );
      args.state.messages.push(...newMessages);
      hasInjectedMessages = true;
      yield* emitToolInjectedMessages({
        messages: newMessages,
        deps: args.deps,
        toolUseId: er.toolUseId,
      });
    }
    if (er.result.contextModifier) {
      const modelSwitched = applySkillStateOverrides(args.state, er.result.contextModifier, args.tokenEstimator, args.activeSkillRef);
      if (modelSwitched) yield buildModelOverrideNotice(modelSwitched);
      const modeNotice = await applyModeOverride({
        mod: er.result.contextModifier,
        config: args.config,
        toolParams: args.toolParams,
        toolMap: args.toolMap,
        staticToolNames: args.staticToolNames,
        toolRegistry: args.toolRegistry,
        state: args.state,
        systemPromptRawRef: args.systemPromptRawRef,
      });
      if (modeNotice) yield modeNotice;
    }
  }
  return hasInjectedMessages;
}

export function recalculatePostInjectPressure(args: {
  hasInjectedMessages: boolean;
  state: EngineState;
  config: EngineConfig;
  tokenEstimator: TokenEstimator;
}): void {
  if (!args.hasInjectedMessages) return;
  const postInjectTokens = args.tokenEstimator.estimateWithAnchor(
    args.state.messages,
    args.state._lastUsageAnchor,
  );
  const postInjectWindow = args.config.resolveContextWindow?.(args.state.model)
    ?? args.config.contextWindowTokens
    ?? DEFAULT_CONTEXT_WINDOW;
  args.state.contextPressure = Math.min(1, postInjectTokens / postInjectWindow);
}

export function updateContextPressureAfterTurn(
  state: EngineState,
  config: EngineConfig,
  tokenEstimator: TokenEstimator,
): void {
  const currentTokens = tokenEstimator.estimateWithAnchor(
    state.messages,
    state._lastUsageAnchor,
  );
  const contextWindow = config.resolveContextWindow?.(state.model)
    ?? config.contextWindowTokens
    ?? DEFAULT_CONTEXT_WINDOW;
  state.contextPressure = Math.min(1, currentTokens / contextWindow);
}

export function extractEnvironmentContextText(state: EngineState): string | undefined {
  const envMsg = state.messages.find((m) =>
    hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.CONTEXT_INJECTION),
  );
  const envContent = envMsg?.content;
  if (typeof envContent === 'string') return envContent;
  if (!Array.isArray(envContent)) return undefined;
  return envContent.find(
    (b): b is { type: 'text'; text: string } =>
      (b as { type?: string }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string',
  )?.text;
}

/** ：提取本 run fresh 注入的 agent-profile 全文（供落库 UserEvent）。 */
export function extractAgentProfileContextText(state: EngineState): string | undefined {
  const profileMsg = state.messages.find((m) =>
    hasInternalMarker(m, INTERNAL_MESSAGE_MARKERS.AGENT_PROFILE_INJECTION),
  );
  const content = profileMsg?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  return content.find(
    (b): b is { type: 'text'; text: string } =>
      (b as { type?: string }).type === 'text' &&
      typeof (b as { text?: unknown }).text === 'string',
  )?.text;
}
