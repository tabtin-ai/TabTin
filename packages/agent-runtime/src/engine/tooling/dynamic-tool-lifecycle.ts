/**
 * 动态工具生命周期：skill 触发后从历史恢复激活、记录使用、TTL 驱逐（含驱逐
 * SYSTEM_NOTICE + tool-eviction 上下文注入）。自 query.ts 抽出。
 */
import { buildUserContextWrapper } from '../context/user-context-wrapper.js';
import { buildToolParams } from './tool-params.js';
import {
  INTERNAL_MESSAGE_MARKERS,
  setInternalMarker,
} from '../contracts/conversation.js';
import type { DynamicToolManager } from './dynamic-tool-manager.js';
import type { ToolRegistry } from './tool-system.js';
import type { ToolExecutionResult } from './tool-orchestration.js';
import type {
  SystemNoticeEvent,
} from '../contracts/wire-protocol.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import type {
  Message,
  ToolParam,
} from '../contracts/conversation.js';
import type {
  Tool,
} from '../contracts/tools.js';
import type {
  EngineConfig,
  EngineState,
} from '../contracts/kernel.js';

export function recoverDynamicToolsFromMessages(args: {
  messages: Message[];
  dynamicToolManager: DynamicToolManager;
  config: EngineConfig;
  staticToolNames: Set<string>;
  toolMap: Map<string, Tool>;
  toolParams: ToolParam[];
  toolRegistry: ToolRegistry;
  iteration: number;
}): void {
  const recovered = args.dynamicToolManager.recoverFromMessages(
    args.messages,
    args.config.tools,
    args.staticToolNames,
    args.iteration,
  );
  for (const name of recovered) {
    const tool = args.dynamicToolManager.getTool(name);
    if (!tool || args.toolMap.has(name)) continue;
    args.toolMap.set(name, tool);
    args.toolParams.push(buildToolParams([tool])[0]!);
    args.toolRegistry.loadTools({ getTools: () => [tool] });
  }
}

export function recordDynamicToolUsage(
  executionResults: ToolExecutionResult[],
  dynamicToolManager: DynamicToolManager,
  iteration: number,
): void {
  for (const er of executionResults) {
    if (dynamicToolManager.has(er.toolName)) {
      dynamicToolManager.recordUsage(er.toolName, iteration);
    }
  }
}

export function evictDynamicTools(
  dynamicToolManager: DynamicToolManager,
  iteration: number,
  toolParams: ToolParam[],
  toolMap: Map<string, Tool>,
  state: EngineState,
): SystemNoticeEvent | null {
  const evictedTools = dynamicToolManager.evictStale(iteration);
  if (evictedTools.length === 0) return null;
  for (const name of evictedTools) {
    const idx = toolParams.findIndex(t => t.name === name);
    if (idx >= 0) toolParams.splice(idx, 1);
    toolMap.delete(name);
  }
  const evictedListCn = evictedTools.map(n => `\`${n}\``).join('、');
  const noticeContent =
    `以下工具已因长时间未使用被自动回收：${evictedListCn}。` +
    `请勿继续调用；如仍需要，可用 skills_read 重新读取对应 Skill。`;
  const wrappedNotice = buildUserContextWrapper('tool-eviction', `[system] ${noticeContent}`);
  state.messages.push(setInternalMarker(
    { role: 'user' as const, content: [{ type: 'text' as const, text: wrappedNotice }] },
    INTERNAL_MESSAGE_MARKERS.TOOL_EVICTION_NOTICE,
  ));
  return new RuntimeSystemNoticeEvent({
      content: noticeContent,
      notice_type: 'tools_evicted',
      tools: evictedTools,
      severity: 'info',
  }).toStreamEvent();
}
