/**
 * RetryState — structured state for query-level error recovery.
 *
 * Replaces scattered local variables (consecutive5xxCount, promptTooLongRecoveryCount)
 * with a single cohesive structure that tracks all recovery attempts within one query.
 *
 * QuerySource enables foreground/background differentiation for 529 handling —
 * background tasks (title_generation, memory_extraction) bail immediately on 529
 * instead of burning retry budget.
 */

export type QuerySource =
  | 'user_message'
  | '_sub_agent'
  | '_compact'
  | '_summary_judge'
  | '_digest'
  | 'title_generation'
  | 'memory_extraction'
  | 'auto_condense';

export const FOREGROUND_SOURCES: ReadonlySet<QuerySource> = new Set([
  'user_message',
  '_sub_agent',
  '_compact',
  '_summary_judge',
  // digest 工具在主循环的 tool_use 里同步等待结果，属前台调用。
  '_digest',
  'auto_condense',
]);

export interface RetryState {
  consecutive5xxCount: number;
  ptlRecoveryAttempts: number;
  fallbackAttempted: boolean;
  originalModel: string;
  currentModel: string;
  querySource: QuerySource;
}

export function createRetryState(model: string, querySource: QuerySource = 'user_message'): RetryState {
  return {
    consecutive5xxCount: 0,
    ptlRecoveryAttempts: 0,
    fallbackAttempted: false,
    originalModel: model,
    currentModel: model,
    querySource,
  };
}
