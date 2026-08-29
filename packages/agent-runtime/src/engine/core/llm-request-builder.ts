/**
 * LLM 请求构造领域（ 批次 6d，自 query.ts 收编）——LLMRequest 拼装、
 * maxTokens 决策、retry notice 入队。Prompt section 的 registry / ordering /
 * materialize 归 `context/prompt-section-assembler.ts` 所有，core 只收集贡献并消费产物。
 *
 * 协作对象形态：构造时注入一次 RunContext，主循环（AgentLoop）每轮调
 * `createAssembly()` / `buildRequest()`；`appendSystemSection` 回调
 * （beforeModel hook ctx）也由本类提供。
 */
import type {
  SystemSection,
  SystemSectionName,
} from '../contracts/wire-protocol.js';
import { SYSTEM_SECTION_NAMES } from '../contracts/wire-protocol.js';
import type {
  SystemBlock,
  ToolParam,
} from '../contracts/conversation.js';
import type {
  LLMRequest,
} from '../contracts/model-llm.js';
import type { RunContext } from './run-context.js';
import { RuntimeSystemNoticeEvent } from '../../event/events/observability-events.js';
import { projectLlmRequest } from '../context/llm-context-projection.js';
import { createStableToolParamsMemo } from '../tooling/tool-params.js';
import {
  buildToolCallMetadataContract,
  stripToolCallMetadataFromEnvelopeHint,
} from '../tooling/tool-call-metadata.js';
import type {
  MaterializedPrompt,
  PromptAssemblyState,
} from '../context/prompt-section-assembler.js';
import {
  createPromptAssembly,
  materializePrompt,
} from '../context/prompt-section-assembler.js';

const DEFAULT_MAX_TOKENS = 16_384;
const MAX_SAFE_OUTPUT_TOKENS = 128_000;

export type {
  MaterializedPrompt,
  PromptAssemblyState,
} from '../context/prompt-section-assembler.js';

/**
 * 根据 EngineConfig.maxOutputTokens（来自 Django catalog）决定 LLM 请求的 max_tokens。
 *
 * - 有配置 → 直接用（cap 在 128k 安全上限），让模型能力完整释放
 * - 无配置 → 回退 16k（保守安全）
 *
 * 不做 Math.max(configMaxOutput, DEFAULT_MAX_TOKENS)——当模型上限 < 16k
 * （如 Claude 3.5 Sonnet 8k）时，发 16k 会超模型能力导致 API 400。
 */
function resolveMaxTokensForRequest(configMaxOutput?: number): number {
  if (!configMaxOutput || configMaxOutput <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(configMaxOutput, MAX_SAFE_OUTPUT_TOKENS);
}

export function deriveBillingIdempotencyKey(
  billingScope: string | undefined,
  requestSource: string,
  callIndex: number,
): string | undefined {
  if (!billingScope) return undefined;
  return `agent-turn:${billingScope}:${requestSource}:${callIndex}`;
}

/** retry notice 入队：延迟到 LLM 调用成功 / 失败边界统一 flush（loop 负责）。 */
function queueRetryNotice(
  ctx: RunContext,
  info: Parameters<NonNullable<LLMRequest['onRetryAttempt']>>[0],
): void {
  const state = ctx.state;
  const notices = state.__pendingNotices ?? (state.__pendingNotices = []);
  notices.push(new RuntimeSystemNoticeEvent({
      content: info.isStallRetry
        ? `回复中断，正在重新获取（第 ${info.attempt}/${info.maxRetries} 次）…`
        : `服务暂时不可用，正在重试（第 ${info.attempt}/${info.maxRetries} 次）…`,
      notice_type: 'llm_retry',
      severity: info.attempt <= 2 ? 'silent' : 'info',
      attempt: info.attempt,
      maxRetries: info.maxRetries,
      delayMs: info.delayMs,
      isStallRetry: info.isStallRetry ?? false,
  }).toStreamEvent());
  if (info.isStallRetry) ctx.stallRetryRef.current = true;
}

export class LlmRequestBuilder {
  private readonly getStableToolParams = createStableToolParamsMemo();
  private billingCallIndex = 0;

  constructor(private readonly ctx: RunContext) {}

  /** 每轮开一份新的 prompt 装配（base 段 + 动态段注册表）。 */
  createAssembly(): PromptAssemblyState {
    const assembly = createPromptAssembly(this.ctx.getSystemPromptRaw());
    this.appendSection(
      assembly,
      SYSTEM_SECTION_NAMES.tool_call_metadata,
      buildToolCallMetadataContract(),
      'agent-runtime',
      'static',
    );
    return assembly;
  }

  /** beforeModel hook ctx 的 appendSystemSection 回调实现（收集，不拼串）。 */
  appendSection(
    assembly: PromptAssemblyState,
    name: SystemSectionName,
    content: string,
    source: string,
    placement?: 'static' | 'dynamic',
  ): void {
    const section: SystemSection = { name, source, content, charCount: content.length };
    if (placement === 'static') {
      assembly.staticSections.push(section);
    } else {
      assembly.dynamicSections.push(section);
    }
  }

  /** 收集完成后按规范序拼装（loop 在 hook 栈跑完后调一次）。 */
  materialize(assembly: PromptAssemblyState): MaterializedPrompt {
    return materializePrompt(assembly);
  }

  buildRequest(
    isGraceCallTurn: boolean,
    toolAllowlist: readonly string[] | null,
    forceToolCall: boolean,
    systemPrompt: string | SystemBlock[] | undefined,
  ): LLMRequest {
    const ctx = this.ctx;
    const requestSource = ctx.retryState.querySource === 'user_message'
      ? '_main_chat'
      : ctx.retryState.querySource;
    const logicalBillingKey = deriveBillingIdempotencyKey(
      ctx.params.billingIdempotencyScope,
      requestSource,
      this.billingCallIndex,
    );
    if (logicalBillingKey) this.billingCallIndex += 1;
    //  投影单点：与组装根 guardedCreateStream 调同一个 projectLlmRequest
    // （幂等双过）。这里投影是为了 LLM_REQUEST debug 快照与实际入模一致；
    // provider 出口在 guardedCreateStream 再过一次，兜住 compact / 摘要 / fork
    // 等不经过本函数的直连出口。
    const requestTools = this.resolveRequestTools(isGraceCallTurn, toolAllowlist);
    const request: LLMRequest & { logicalBillingKey?: string } = {
      model: ctx.state.model,
      messages: ctx.state.messages,
      tools: requestTools,
      // 协议层强制调工具（beforeModel forceToolCall）：grace turn 无工具时不带。
      toolChoice: forceToolCall && !isGraceCallTurn ? 'required' : undefined,
      system: systemPrompt,
      maxTokens: resolveMaxTokensForRequest(ctx.config.maxOutputTokens),
      requestSource,
      logicalBillingKey,
      // Backward-compatible alias until all call sites speak the logical/attempt split.
      billingIdempotencyKey: logicalBillingKey,
      onRetryAttempt: (info) => queueRetryNotice(ctx, info),
      onContentBlockEvent: (hint) => {
        const streamedToolName = hint.kind === 'agent.stream.content_block_start'
          && hint.block.type === 'tool_use'
          ? hint.block.name
          : undefined;
        const toolInputSchema = streamedToolName
          ? requestTools?.find((tool) => tool.name === streamedToolName)?.input_schema
          : undefined;
        ctx.envelopeEmitter.pushHint(
          stripToolCallMetadataFromEnvelopeHint(hint, toolInputSchema),
        );
      },
    };

    return projectLlmRequest(
      request,
      //  批次 12：读 RunContext 已解析开关（loop 构造时 `?? true` 兜底一次）。
      // FR-09 / 中性化：shell untrusted 谓词由宿主经 EngineConfig 注入，透传至 LLM 边界。
      { toolOutputScan: ctx.toolOutputScan, isUntrustedShellCommand: ctx.config.isUntrustedShellCommand },
    );
  }

  private resolveRequestTools(
    isGraceCallTurn: boolean,
    toolAllowlist: readonly string[] | null,
  ): ToolParam[] | undefined {
    if (isGraceCallTurn) return undefined;
    let toolParams = this.ctx.getToolParams();
    // beforeModel hook 的本轮工具面白名单（restrictToolsForTurn）。
    if (toolAllowlist) {
      const allowed = new Set(toolAllowlist);
      toolParams = toolParams.filter((t) => allowed.has(t.name));
    }
    return toolParams.length > 0 ? this.getStableToolParams(toolParams) : undefined;
  }
}
