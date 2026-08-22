import type {
  Message,
} from '../engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../engine/contracts/model-llm.js';
import { compactConversation } from './compact.js';
import { estimateTokens, type TokenEstimator } from '../engine/context/token-budget.js';

export interface CompactCheckpointSummaryParams {
  messages: Message[];
  systemPrompt: string;
  model: string;
  callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  keepLastN?: number;
  contextWindowTokens?: number;
  transcriptPath?: string;
  estimator?: TokenEstimator;
  summaryFocus?: string;
}

export interface CompactCheckpointSummary {
  summary: string;
  stats: {
    messages_before: number;
    messages_after: number;
    tokens_before: number;
    tokens_after: number;
    tokens_freed: number;
    summary_length: number;
  };
}

export async function summarizeHistoryForCheckpoint(
  params: CompactCheckpointSummaryParams,
): Promise<CompactCheckpointSummary> {
  const tokensBefore = estimateTokens(params.messages, params.estimator);
  const compactResult = await compactConversation({
    messages: params.messages,
    systemPrompt: params.systemPrompt,
    model: params.model,
    callModel: params.callModel,
    keepLastN: params.keepLastN,
    contextWindowTokens: params.contextWindowTokens,
    transcriptPath: params.transcriptPath,
    estimator: params.estimator,
    enableSummaryReuse: false,
    summaryFocus: params.summaryFocus,
  });
  const tokensAfter = estimateTokens(compactResult.compactedMessages, params.estimator);
  const summary = compactResult.summary.trim();

  return {
    summary,
    stats: {
      messages_before: params.messages.length,
      messages_after: compactResult.compactedMessages.length,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_freed: Math.max(0, tokensBefore - tokensAfter),
      summary_length: summary.length,
    },
  };
}
