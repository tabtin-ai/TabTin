/**
 * ：runtime `buildChildCompletionEnvelope` ↔ wire `createSubagentCompletionPayload`
 * 字段镜像 parity（AH-005 双份实现必须同构）。
 */

import { describe, expect, it } from 'vitest';
import {
  createSubagentCompletionPayload,
  SubagentCompletionEnvelopeSchema,
} from '@tabtin/agent-wire';
import { buildChildCompletionEnvelope } from '../src/subagent/completion-envelope.js';

const FIXTURES = [
  {
    name: 'minimal completed',
    runtime: {
      subagentRunId: 'run-1',
      label: '调研',
      status: 'completed' as const,
      summary: 'done',
      durationMs: 1200,
    },
    wire: {
      subagent_run_id: 'run-1',
      label: '调研',
      status: 'completed' as const,
      summary: 'done',
      duration_ms: 1200,
    },
  },
  {
    name: 'full optional fields + empty deliverables stripped',
    runtime: {
      subagentRunId: 'run-2',
      label: 'bg',
      status: 'failed' as const,
      summary: 'boom',
      durationMs: 50,
      stepCount: 3,
      errorKind: 'timeout',
      runId: 'dispatcher-run',
      toolCallId: 'toolu-dispatch',
      parentToolCallId: 'tu-9',
      stats: { duration_ms: 50, total_tokens: 10 },
      deliverables: [] as unknown[],
      background: true,
      summaryFilePath: '/tmp/summary.md',
    },
    wire: {
      subagent_run_id: 'run-2',
      label: 'bg',
      status: 'failed' as const,
      summary: 'boom',
      duration_ms: 50,
      step_count: 3,
      error_kind: 'timeout',
      run_id: 'dispatcher-run',
      tool_call_id: 'toolu-dispatch',
      parent_tool_call_id: 'tu-9',
      stats: { duration_ms: 50, total_tokens: 10 },
      deliverables: [] as unknown[],
      background: true,
      summary_file_path: '/tmp/summary.md',
    },
  },
  {
    name: 'non-empty deliverables kept',
    runtime: {
      subagentRunId: 'run-3',
      label: 'x',
      status: 'cancelled' as const,
      summary: '',
      durationMs: 1,
      deliverables: [{ kind: 'file', path: 'a.ts' }],
    },
    wire: {
      subagent_run_id: 'run-3',
      label: 'x',
      status: 'cancelled' as const,
      summary: '',
      duration_ms: 1,
      deliverables: [{ kind: 'file', path: 'a.ts' }],
    },
  },
] as const;

describe('#9155 completion envelope parity (runtime ↔ wire)', () => {
  it.each(FIXTURES)('$name：两端 builder 输出一致且过 wire zod', ({ runtime, wire }) => {
    const fromRuntime = buildChildCompletionEnvelope(runtime);
    const fromWire = createSubagentCompletionPayload(wire);
    expect(fromRuntime).toEqual(fromWire);
    expect(SubagentCompletionEnvelopeSchema.safeParse(fromRuntime).success).toBe(true);
    expect(SubagentCompletionEnvelopeSchema.safeParse(fromWire).success).toBe(true);
  });

  it('空 deliverables 不出现在输出键上', () => {
    const env = buildChildCompletionEnvelope({
      subagentRunId: 'r',
      label: 'l',
      status: 'completed',
      summary: 's',
      durationMs: 1,
      deliverables: [],
    });
    expect('deliverables' in env).toBe(false);
  });
});
