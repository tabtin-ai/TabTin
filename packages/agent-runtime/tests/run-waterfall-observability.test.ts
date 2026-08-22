import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';
import type { ToolRiskPolicyPort } from '../src/engine/contracts/tool-risk-policy.js';

const allowToolRiskPolicy: ToolRiskPolicyPort = {
  resolveSnapshot: () => undefined,
  judge: () => ({ behavior: 'allow', reason: { type: 'test_allow' } }),
  buildMemoPatternKey: (input) => `test:${input.toolName}`,
  forWorkspaceRoot: () => allowToolRiskPolicy,
  forReadonlyChild: () => allowToolRiskPolicy,
};

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    toolRiskPolicy: allowToolRiskPolicy,
    ...overrides,
  };
}

function makeTool(name: string, execute?: Tool['execute']): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    execute: execute ?? (async () => ({ content: 'ok' })),
  };
}

function lifecycle(
  events: StreamEvent[],
  phase: string,
): Array<Record<string, unknown>> {
  return events
    .filter((e) => e.type === 'agent.stream.lifecycle')
    .map((e) => e.payload)
    .filter((payload) => payload.phase === phase);
}

describe('run waterfall observability', () => {
  it('emits run end duration and turn lifecycle events', async () => {
    const rt = createRuntime(makeConfig({
      provider: createMockProvider([
        [
          { type: 'text_delta', text: 'hello' },
          { type: 'stop', stopReason: 'end_turn' },
        ],
      ]),
    }));

    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'hello' }));

    const [runStart] = lifecycle(events, 'start');
    const [runEnd] = lifecycle(events, 'end');
    expect(runStart?.run_id).toBeTruthy();
    expect(runEnd?.run_id).toBe(runStart?.run_id);
    expect(runEnd?.started_at).toBe(runStart?.started_at);
    expect(typeof runEnd?.duration_ms).toBe('number');
    expect(runEnd?.duration_ms as number).toBeGreaterThanOrEqual(0);

    const [turnStart] = lifecycle(events, 'turn_start');
    const [turnEnd] = lifecycle(events, 'turn_end');
    expect(turnStart?.turn_id).toBeTruthy();
    expect(turnEnd?.turn_id).toBe(turnStart?.turn_id);
    expect(turnStart?.source).toBeUndefined();
    expect(turnEnd?.source).toBeUndefined();
    expect(typeof turnEnd?.duration_ms).toBe('number');
    expect(turnEnd?.tool_call_count).toBe(0);
  });

  it('attaches per-turn tool duration summary to turn_end', async () => {
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tool-1', name: 'read_file', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([makeTool('read_file')]),
    }));

    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'read' }));
    const turnEnds = lifecycle(events, 'turn_end');
    const toolTurn = turnEnds.find((payload) => payload.tool_call_count === 1);

    expect(toolTurn).toBeTruthy();
    expect(typeof toolTurn?.tool_duration_ms).toBe('number');
    expect(toolTurn?.tool_durations).toEqual([
      expect.objectContaining({
        tool_name: 'read_file',
        tool_call_id: 'tool-1',
        status: 'completed',
        duration_ms: expect.any(Number),
      }),
    ]);
  });

  it('emits request/response snapshots and one usage summary per LLM iteration', async () => {
    const provider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tool-1', name: 'read_file', input: {} } },
        {
          type: 'usage',
          usage: {
            input_tokens: 50,
            output_tokens: 5,
            cache_read_input_tokens: 10,
            reasoning_tokens: 2,
          },
        },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        {
          type: 'usage',
          usage: {
            input_tokens: 80,
            output_tokens: 7,
            cache_creation_input_tokens: 3,
            reasoning_tokens: 4,
          },
        },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    provider.getRequestMetadata = () => ({
      providerChannel: 'local_codex',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    });
    const rt = createRuntime(makeConfig({
      provider,
      tools: createMockToolProvider([makeTool('read_file')]),
      budgetTracker: new BudgetTracker(),
    }));

    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'read' }));
    const requestSnapshots = events.filter((e) => e.type === 'agent.stream.llm_request');
    const responseSnapshots = events.filter((e) => e.type === 'agent.stream.llm_snapshot');
    const usageEvents = events.filter((e) => e.type === 'agent.stream.llm_usage');

    expect(requestSnapshots).toHaveLength(2);
    expect(responseSnapshots).toHaveLength(2);
    expect(usageEvents).toHaveLength(2);

    expect(requestSnapshots[0]?.payload).toMatchObject({
      runId: 'test-run',
      iterationId: 'test-run:0',
      iteration: 0,
      phase: 'request',
      providerChannel: 'local_codex',
      reasoningEffort: 'high',
      serviceTier: 'priority',
    });
    expect(responseSnapshots[0]?.payload).toMatchObject({
      runId: 'test-run',
      iterationId: 'test-run:0',
      iteration: 0,
      phase: 'response',
      providerChannel: 'local_codex',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      response: expect.objectContaining({ stopReason: 'tool_use' }),
    });
    expect(usageEvents[0]?.payload).toMatchObject({
      runId: 'test-run',
      iterationId: 'test-run:0',
      iteration: 0,
      providerChannel: 'local_codex',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      input_tokens: 50,
      output_tokens: 5,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
      reasoning_tokens: 2,
      last_input_tokens: 50,
      last_cache_read_input_tokens: 10,
      by_model: {
        'test-model': expect.objectContaining({
          input_tokens: 50,
          output_tokens: 5,
          cache_read_tokens: 10,
          reasoning_tokens: 2,
        }),
      },
    });
    expect(usageEvents[1]?.payload).toMatchObject({
      iterationId: 'test-run:1',
      input_tokens: 80,
      output_tokens: 7,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 3,
      reasoning_tokens: 4,
      by_model: {
        'test-model': expect.objectContaining({
          input_tokens: 80,
          output_tokens: 7,
          cache_creation_tokens: 3,
          reasoning_tokens: 4,
        }),
      },
    });
  });
});
