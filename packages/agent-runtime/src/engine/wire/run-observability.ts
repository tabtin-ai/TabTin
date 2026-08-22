/**
 * Run 观测事件构造（ 批次 6g）——lifecycle start/end、turn start/end、
 * thinking step 的 payload 拼装 + ActiveTurnObservation 持有。
 *
 * **时机**（何时 emit）仍归主循环（AgentLoop）；本类只负责「事件长什么样」
 * 与 turn 观测窗口的状态所有权。
 */
import type {
  LifecycleEvent,
  StepEvent,
} from '../contracts/wire-protocol.js';
import {
  RuntimeLifecycleEvent,
  RuntimeStepEvent,
} from '../../event/events/observability-events.js';
import type { ToolExecutionResult } from '../tooling/tool-orchestration.js';

export type ActiveTurnObservation = {
  turnId: string;
  iteration: number;
  startedAt: number;
  toolSummary?: Array<{
    tool_name: string;
    tool_call_id: string;
    duration_ms: number;
    status: 'completed' | 'failed';
  }>;
};

export class RunObservability {
  private readonly runId: string;
  private readonly traceId: string;
  private readonly runStartedAt: number;
  /** ref 形态保留——工具相位在 promise settle 回调里就地写 toolSummary。 */
  readonly activeTurnRef: { current: ActiveTurnObservation | null } = { current: null };

  constructor(args: { runId: string; traceId: string; runStartedAt: number }) {
    this.runId = args.runId;
    this.traceId = args.traceId;
    this.runStartedAt = args.runStartedAt;
  }

  buildLifecycleStartEvent(): LifecycleEvent {
    return new RuntimeLifecycleEvent({
        phase: 'start',
        run_id: this.runId,
        trace_id: this.traceId,
        started_at: this.runStartedAt,
    }).toStreamEvent();
  }

  buildLifecycleEndEvent(): LifecycleEvent {
    const runEndedAt = Date.now();
    return new RuntimeLifecycleEvent({
        phase: 'end',
        run_id: this.runId,
        trace_id: this.traceId,
        started_at: this.runStartedAt,
        ended_at: runEndedAt,
        duration_ms: Math.max(0, runEndedAt - this.runStartedAt),
    }).toStreamEvent();
  }

  buildThinkingStepEvent(iteration: number, status: 'running' | 'done'): StepEvent {
    return new RuntimeStepEvent({
        step_type: 'thinking',
        title: iteration === 0 ? 'Thinking…' : `Thinking… (iteration ${iteration + 1})`,
        status,
        step_id: `${this.runId}-thinking-${iteration}`,
        run_id: this.runId,
    }).toStreamEvent();
  }

  beginTurn(iteration: number): LifecycleEvent {
    const startedAt = Date.now();
    const turnId = `${this.runId}-turn-${iteration}`;
    this.activeTurnRef.current = { turnId, iteration, startedAt };
    return new RuntimeLifecycleEvent({
        phase: 'turn_start',
        run_id: this.runId,
        trace_id: this.traceId,
        turn_id: turnId,
        iteration,
        started_at: startedAt,
    }).toStreamEvent();
  }

  finishTurn(
    status: 'completed' | 'failed' | 'retrying' = 'completed',
    extra?: Record<string, unknown>,
  ): LifecycleEvent | null {
    const turn = this.activeTurnRef.current;
    if (!turn) return null;
    this.activeTurnRef.current = null;
    return this.buildTurnEndEvent(turn, status, extra);
  }

  private buildTurnEndEvent(
    turn: ActiveTurnObservation,
    status: 'completed' | 'failed' | 'retrying',
    extra?: Record<string, unknown>,
  ): LifecycleEvent {
    const finishedAt = Date.now();
    const toolSummary = turn.toolSummary ?? [];
    const toolDurationMs = toolSummary.reduce((sum, item) => sum + item.duration_ms, 0);
    return new RuntimeLifecycleEvent({
        phase: 'turn_end',
        run_id: this.runId,
        trace_id: this.traceId,
        turn_id: turn.turnId,
        iteration: turn.iteration,
        status,
        started_at: turn.startedAt,
        ended_at: finishedAt,
        duration_ms: Math.max(0, finishedAt - turn.startedAt),
        tool_call_count: toolSummary.length,
        ...(toolSummary.length > 0 ? { tool_duration_ms: toolDurationMs, tool_durations: toolSummary } : {}),
        ...(extra ?? {}),
    }).toStreamEvent();
  }
}

/** 工具相位 settle 后回填 turn 观测的 toolSummary（原 updateTurnToolSummary）。 */
export function updateTurnToolSummary(
  activeTurnRef: { current: ActiveTurnObservation | null },
  executionResults: ToolExecutionResult[],
): void {
  if (!activeTurnRef.current) return;
  activeTurnRef.current.toolSummary = executionResults.map((r) => ({
    tool_name: r.toolName,
    tool_call_id: r.toolUseId,
    duration_ms: Math.max(0, r.durationMs),
    status: r.result.isError ? 'failed' : 'completed',
  }));
}
