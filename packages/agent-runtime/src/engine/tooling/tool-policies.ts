/**
 * Tool policies keep per-turn execution knobs and result projection out of
 * ToolPhase. ToolPhase remains the phase coordinator; this module owns the
 * policy-shaped decisions that are not part of the read-parallel/write-serial
 * execution invariant.
 */
import type {
  ToolResultBlock,
} from '../contracts/conversation.js';
import type {
  Tool,
} from '../contracts/tools.js';
import type { RunContext } from '../core/run-context.js';
import { resolveRuntimeMode } from '../core/runtime-helpers.js';
import {
  enforceToolOutputBudget,
  type RunToolsOptions,
  type ToolExecutionResult,
} from './tool-orchestration.js';
import { applyLlmStripKeys } from './tool-system.js';
import { summarizeToolOutput } from './tool-output-summary.js';
import type { WorkspaceBoundary } from '../contracts/tool-risk-policy.js';

export interface ToolExecutionPolicy {
  schemaLevel: RunContext['toolSchemaValidation'];
  outputScanEnabled: boolean;
  /**
   * FR-09 / 中性化：宿主注入的「shell 命令是否返回外部不可信字节」谓词
   * （`EngineConfig.isUntrustedShellCommand`）。pre-start 输出扫描（model-stream）
   * 用它判定 `run_terminal_command` 是否需要 fence；缺省时不 fence。
   */
  isUntrustedShellCommand?: (command: string) => boolean;
  runToolsOptions: RunToolsOptions;
}

export function resolveToolExecutionPolicy(ctx: RunContext): ToolExecutionPolicy {
  return {
    schemaLevel: ctx.toolSchemaValidation,
    outputScanEnabled: ctx.toolOutputScan,
    isUntrustedShellCommand: ctx.config.isUntrustedShellCommand,
    runToolsOptions: {
      schemaValidation: ctx.toolSchemaValidation,
      outputScan: ctx.toolOutputScan,
      isUntrustedShellCommand: ctx.config.isUntrustedShellCommand,
      observe: ctx.deps.observe,
      toolGate: ctx.deps.toolGate,
      interrupt: ctx.deps.interrupt,
      sessionId: ctx.config.sessionConfig?.threadId,
      agentMode: ctx.config.agentMode,
      toolRiskPolicy: (() => {
        if (!ctx.config.toolRiskPolicy) {
          throw new Error(
            '[tool-policies] EngineConfig.toolRiskPolicy is required. ' +
              'Hosts must wire createToolRiskPolicyPort before query().',
          );
        }
        return ctx.config.toolRiskPolicy;
      })(),
      judgeHomeDir: ctx.config.judgeHomeDir,
      osErrorBlacklist: ctx.config.osErrorBlacklist,
      onOSAccessError: ctx.config.onOSAccessError,
      isSubagent: !!ctx.config.budgetScope,
    },
  };
}

export function resolveToolContextPolicy(ctx: RunContext): {
  runtimeMode: ReturnType<typeof resolveRuntimeMode>;
  workspaceSnapshot: WorkspaceBoundary | undefined;
} {
  return {
    runtimeMode: resolveRuntimeMode(ctx.config.runtimeMode),
    workspaceSnapshot: ctx.config.toolRiskPolicy?.resolveSnapshot()?.workspace,
  };
}

export interface ToolPhaseResult {
  rawExecutionResults: ToolExecutionResult[];
  executionResults: ToolExecutionResult[];
}

export function applyToolResultPolicy(args: {
  ctx: RunContext;
  preStartedExecResults: ToolExecutionResult[];
  runToolResults: ToolExecutionResult[];
}): ToolPhaseResult {
  const rawExecutionResults = [...args.preStartedExecResults, ...args.runToolResults];
  const llmScopedResults = rawExecutionResults.map((er) => ({
    ...er,
    result: applyLlmStripKeys(er.result),
  }));
  const executionResults = enforceToolOutputBudget(llmScopedResults, {
    storage: args.ctx.toolResultStorage,
    perToolMaxChars: buildPerToolMaxChars(args.ctx.toolMap),
  });
  return { rawExecutionResults, executionResults };
}

export function buildToolResultBlockSets(args: {
  ctx: RunContext;
  rawExecutionResults: ToolExecutionResult[];
  executionResults: ToolExecutionResult[];
}): {
  llmToolResultBlocks: ToolResultBlock[];
  canonicalToolResultBlocks: ToolResultBlock[];
} {
  const llmToolResultBlocks = args.executionResults.map((result) => ({
    type: 'tool_result' as const,
    tool_use_id: result.toolUseId,
    content: summarizeToolOutput(result.result, {
      toolUseId: result.toolUseId,
      toolName: result.toolName,
      storage: args.ctx.toolResultStorage,
      perToolMax: args.ctx.toolMap.get(result.toolName)?.maxResultSizeChars,
    }),
    is_error: result.result.isError,
  }));
  const rawResultByToolUseId = new Map(args.rawExecutionResults.map((result) => [result.toolUseId, result]));
  const canonicalToolResultBlocks = args.executionResults.map((result, index) => {
    const raw = rawResultByToolUseId.get(result.toolUseId);
    return {
      type: 'tool_result' as const,
      tool_use_id: result.toolUseId,
      content: raw?.result.llmContextContent !== undefined
        ? raw.result.content
        : llmToolResultBlocks[index]!.content,
      is_error: result.result.isError,
      ...(raw?.result.presentation ? { presentation: raw.result.presentation } : {}),
    };
  });
  return { llmToolResultBlocks, canonicalToolResultBlocks };
}

function buildPerToolMaxChars(toolMap: Map<string, Tool>): Map<string, number> | undefined {
  const perToolMaxChars = new Map<string, number>();
  for (const [toolName, toolDefinition] of toolMap) {
    if (toolDefinition.maxResultSizeChars != null && Number.isFinite(toolDefinition.maxResultSizeChars)) {
      perToolMaxChars.set(toolName, toolDefinition.maxResultSizeChars);
    }
  }
  return perToolMaxChars.size > 0 ? perToolMaxChars : undefined;
}
