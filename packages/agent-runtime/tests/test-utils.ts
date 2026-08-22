/**
 * Shared mock factories for agent-runtime engine tests.
 *
 * These were previously exported from engine/types.ts but do NOT belong
 * in production bundles. Import from this file in tests instead.
 */

import type {
  LLMProvider,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
  ToolProvider,
} from '../src/engine/contracts/tools.js';
import type {
  EnginePermissionHandler,
  PermissionDecisionResult,
} from '../src/engine/contracts/hitl.js';

export function createMockProvider(
  responses: LLMResponseChunk[][] = [],
): LLMProvider {
  let callIndex = 0;
  return {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      const chunks = responses[callIndex++] ?? [
        { type: 'text_delta', text: 'mock response' },
        { type: 'stop', stopReason: 'end_turn' },
      ];
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

export function createMockPermissionHandler(
  defaultDecision: PermissionDecisionResult = 'allow',
): EnginePermissionHandler {
  return {
    async requestPermissionsBatch(request): Promise<Array<{ toolCallId: string; decision: PermissionDecisionResult }>> {
      return request.requests.map(r => ({
        toolCallId: r.toolCallId ?? r.tool.name,
        decision: defaultDecision,
      }));
    },
  };
}

export function createMockToolProvider(tools: Tool[] = []): ToolProvider {
  return {
    getTools: () => tools,
  };
}
