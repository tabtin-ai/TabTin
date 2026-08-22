/**
 * @tabtin/agent-runtime/history — 跨轮记忆共享模块。
 *
 * 宿主无关的消息装填逻辑：从持久化/内存消息源选出最近 N 轮历史，
 * 展开 tool_use/tool_result 对，构建 runtime.query 的 initialMessages。
 *
 * 各宿主（Electron / Daemon / CLI）只需：
 * 1. 从自己的数据源获取 HistorySourceMessage[]
 * 2. 调用 selectRecentHistoryForRuntime 做选片 + 展开
 * 3. 调用 buildInitialMessages 拼装最终入参
 */

export type {
  RuntimeHistoryMessage,
  HistorySourceMessage,
  HistoryMessageBlock,
  SelectRecentHistoryOptions,
  CrossTurnMemoryConfig,
} from './types.js';

export {
  KNOWN_HISTORY_BLOCK_TYPES,
  DEFAULT_MAX_HISTORY_MESSAGES,
  TOOL_RESULT_MAX_CHARS,
  EXCLUDED_FROM_LLM_HISTORY_MESSAGE_KINDS,
} from './types.js';

export {
  selectRecentHistoryForRuntime,
  keepLatestAgentProfileMessages,
} from './select-recent-history.js';
export { buildReplayHistoryFromTranscript } from './replay-transcript-history.js';
export {
  mergeExternalArchiveBoundaryIntoHistory,
  isExternalArchiveLocalOnlyMessage,
  EXTERNAL_ARCHIVE_MESSAGE_ID_PREFIX,
  EXTERNAL_ARCHIVE_MESSAGE_KIND,
} from './merge-external-archive-boundary.js';
export type { RendererHistoryLike } from './merge-external-archive-boundary.js';
export { filterUnresolvedToolUses } from './filter-unresolved-tool-uses.js';
export { isCrossTurnMemoryEnabled } from './cross-turn-memory.js';
export type { EnvKillSwitchReader } from './cross-turn-memory.js';
export {
  buildInitialMessages,
  buildUserMessageWithAttachments,
} from './build-initial-messages.js';
export type { UserMessageAttachment } from './build-initial-messages.js';
