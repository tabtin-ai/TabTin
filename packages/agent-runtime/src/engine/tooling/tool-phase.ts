/**
 * 工具执行相位（ 批次 6e，自 query.ts 收编到 tooling 域）。
 *
 * 收编内容：ToolContext 装配、预启动工具 resolve、runTools 调度、输出预算、
 * 结果块集（LLM 视图 vs canonical 视图）、工具信号扫描。
 * 协作对象形态：构造时注入一次 RunContext，主循环只调语义方法。
 */
import type {
  StreamEvent,
} from '../contracts/wire-protocol.js';
import type {
  ToolResultBlock,
  ToolUseBlock,
} from '../contracts/conversation.js';
import type {
  ToolContext,
  ToolCallMetadata,
} from '../contracts/tools.js';
import type { RunContext } from '../core/run-context.js';
import type { HookRunner } from '../core/hook-runner.js';
import { runTools } from './tool-orchestration.js';
import type { ToolExecutionResult } from './tool-orchestration.js';
import { buildToolSkillContext } from './skill-slash.js';
import { resolvePreStartedTools } from '../core/model-stream.js';
import type { PreStartedToolState } from '../core/model-stream.js';
import { updateTurnToolSummary } from '../wire/run-observability.js';
import type { ActiveTurnObservation } from '../wire/run-observability.js';
import {
  applyToolResultPolicy,
  buildToolResultBlockSets as buildPolicyToolResultBlockSets,
  resolveToolContextPolicy,
  resolveToolExecutionPolicy,
} from './tool-policies.js';
import type { ToolPhaseResult } from './tool-policies.js';
import { resolveToolNotificationThreadId } from './notification-thread.js';
export type { ToolPhaseResult } from './tool-policies.js';

export class ToolPhase {
  constructor(
    private readonly ctx: RunContext,
    private readonly hookRunner: Pick<HookRunner, 'runBeforeTool' | 'runAfterTool'>,
    private readonly activeTurnRef: { current: ActiveTurnObservation | null },
  ) {}

  /** 主循环 ToolContext 装配（工具执行 + 只读预启动共用）。 */
  buildToolContext(): ToolContext {
    const { ctx } = this;
    const { runtimeMode, workspaceSnapshot } = resolveToolContextPolicy(ctx);
    const threadId = ctx.config.businessThreadId ?? ctx.config.sessionConfig.threadId;
    return {
      threadId,
      notificationThreadId: resolveToolNotificationThreadId({
        threadId,
        assistantSubagentRunId: ctx.config.subagentRunId,
      }),
      agentRunId: ctx.runId,
      runtimeId: ctx.runtimeId,
      model: ctx.state.model,
      runtimeMode,
      subagentDepth: ctx.config.subagentDepth ?? 0,
      billingIdempotencyScope: ctx.params.billingIdempotencyScope,
      workspaceRoot: ctx.config.workspaceRoot,
      workspaceSnapshot,
      abortSignal: ctx.abortController.signal,
      messages: ctx.state.messages,
      // ：给 ask-tools / LocalPermissionHandler 的 HITL 挂起前 partial
      // persist 用（`hitl-persist.ts`）；两个字段必须与 `buildAssistantPersistEvent`
      // 同源，让 partial 与 final upsert 到同一条 ChatMessage。
      assistantMessageId: ctx.state.currentAssistantMessageId,
      assistantSubagentRunId: ctx.config.subagentRunId,
      emitStreamEvent: ctx.config.emitStreamEvent,
      emitRichContentBlock: ctx.toolStreamEmitter.makeRichContentBlockEmitter(),
      waitForUserInput: ctx.config.waitForUserInput,
      interrupt: ctx.deps.interrupt,
      skillContext: buildToolSkillContext(ctx.activeSkillRef.current),
      readFileState: ctx.config.readFileState,
      imageReadFileState: ctx.config.imageReadFileState,
      localDocReadFileState: ctx.config.localDocReadFileState,
      fileHistory: ctx.config.fileHistory,
      fileHistoryAnchorId: ctx.anchorId,
    };
  }

  /** 工具执行相位：预启动 resolve → runTools → 输出预算 → turn 观测回填 → afterTool 钩子。 */
  async *executeTools(args: {
    toolUseBlocks: ToolUseBlock[];
    toolCallMetadataById: ReadonlyMap<string, ToolCallMetadata>;
    preStartedTools: PreStartedToolState;
  }): AsyncGenerator<StreamEvent, ToolPhaseResult, undefined> {
    const { ctx } = this;
    const policy = resolveToolExecutionPolicy(ctx);
    const { preStartedExecResults, remainingToolUseBlocks } = yield* resolvePreStartedTools({
      toolUseBlocks: args.toolUseBlocks,
      preStartedTools: args.preStartedTools,
      toolMap: ctx.toolMap,
      schemaLevel: policy.schemaLevel,
      outputScanEnabled: policy.outputScanEnabled,
      isUntrustedShellCommand: policy.isUntrustedShellCommand,
    });
    const runToolResults = yield* drainToolGenerator(runTools({
      toolUseBlocks: remainingToolUseBlocks,
      toolCallMetadataById: args.toolCallMetadataById,
      registry: ctx.toolRegistry,
      context: this.buildToolContext(),
      permissionHandler: ctx.config.permissionHandler,
      beforeTool: ({ toolUseId, tool, input }) => this.hookRunner.runBeforeTool({
        toolUseId,
        tool,
        input,
      }),
      options: policy.runToolsOptions,
    }));
    const { rawExecutionResults, executionResults } = applyToolResultPolicy({
      ctx,
      preStartedExecResults,
      runToolResults,
    });
    updateTurnToolSummary(this.activeTurnRef, executionResults);
    yield* this.runAfterToolHooks(executionResults, args.toolUseBlocks);
    return { rawExecutionResults, executionResults };
  }

  /** 工具信号扫描（endConversation / pendingCondense / suspendRun）。 */
  scanSignals(executionResults: ToolExecutionResult[]): {
    shouldEndConversation: boolean;
    terminationReason: string;
    suspension: {
      reason: 'awaiting_subagents';
      pendingSubagentIds: string[];
      onDiscard?: () => void;
    } | null;
  } {
    let shouldEndConversation = false;
    let terminationReason = '';
    let suspension: {
      reason: 'awaiting_subagents';
      pendingSubagentIds: string[];
      onDiscard?: () => void;
    } | null = null;
    for (const er of executionResults) {
      const sig = er.result.signals;
      if (!sig) continue;
      if (sig.endConversation) {
        shouldEndConversation = true;
        terminationReason = sig.endConversation.reason || 'Agent terminated the conversation';
      }
      if (sig.pendingCondense) this.ctx.state.pendingCondenseSummary = sig.pendingCondense.context;
      if (sig.suspendRun) {
        suspension = {
          reason: sig.suspendRun.reason,
          pendingSubagentIds: [...new Set(sig.suspendRun.pendingSubagentIds)].sort(),
          ...(sig.suspendRun.onDiscard ? { onDiscard: sig.suspendRun.onDiscard } : {}),
        };
      }
    }
    return { shouldEndConversation, terminationReason, suspension };
  }

  /**
   * 结果块集：LLM 视图（summarize / persist+reference 截断）与 canonical 视图
   * （UI / 落库拿全量）分离。
   */
  buildToolResultBlockSets(
    rawExecutionResults: ToolExecutionResult[],
    executionResults: ToolExecutionResult[],
  ): { llmToolResultBlocks: ToolResultBlock[]; canonicalToolResultBlocks: ToolResultBlock[] } {
    return buildPolicyToolResultBlockSets({
      ctx: this.ctx,
      rawExecutionResults,
      executionResults,
    });
  }

  private async *runAfterToolHooks(
    executionResults: ToolExecutionResult[],
    toolUseBlocks: ToolUseBlock[],
  ): AsyncGenerator<StreamEvent, void, undefined> {
    const inputByToolUseId = new Map<string, unknown>();
    for (const tu of toolUseBlocks) inputByToolUseId.set(tu.id, tu.input);
    for (const er of executionResults) {
      const tool = this.ctx.toolMap.get(er.toolName);
      if (!tool) continue;
      yield* this.hookRunner.runAfterTool({
        toolUseId: er.toolUseId,
        tool,
        input: inputByToolUseId.get(er.toolUseId),
        result: er.result,
      });
    }
  }

}

async function* drainToolGenerator(
  toolGen: AsyncGenerator<StreamEvent, ToolExecutionResult[], undefined>,
): AsyncGenerator<StreamEvent, ToolExecutionResult[], undefined> {
  let genResult = await toolGen.next();
  while (!genResult.done) {
    yield genResult.value;
    genResult = await toolGen.next();
  }
  return genResult.value;
}
