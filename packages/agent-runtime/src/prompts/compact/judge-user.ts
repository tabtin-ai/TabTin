/**
 * Compact 路径——summary judge 评分调用的 user prompt builder。
 *
 * SSoT 由本文件持有。来源为旧 `compact/summary-judge.ts:96-117` 的
 * `buildJudgeUserPrompt`；按宪法 v0.1 §3.1 资源化。
 *
 * 拼接顺序：PRIOR_SUMMARY → NEW_MESSAGES（轻量预览，由调用方先用
 * `renderMessagesPreviewForJudge` 压缩）→ UPDATED_SUMMARY → 评分指令。
 */

import type {
  Message,
} from '../../engine/contracts/conversation.js';
import { renderMessagesPreviewForJudge } from '../../compact/incremental-prompt.js';

const NEW_MESSAGES_PREVIEW_MAX_CHARS = 4_000;

export function buildJudgeUserPrompt(
  previousSummary: string,
  newSummary: string,
  addedMessages: Message[],
): string {
  const newMessagesPreview = renderMessagesPreviewForJudge(
    addedMessages,
    NEW_MESSAGES_PREVIEW_MAX_CHARS,
  );
  return [
    '=== PRIOR_SUMMARY ===',
    previousSummary,
    '=== END PRIOR_SUMMARY ===',
    '',
    '=== NEW_MESSAGES（自 prior summary 之后）===',
    newMessagesPreview,
    '=== END NEW_MESSAGES ===',
    '',
    '=== UPDATED_SUMMARY（待评估的候选）===',
    newSummary,
    '=== END UPDATED_SUMMARY ===',
    '',
    '请按评分标准为 UPDATED_SUMMARY 打分。只回复那一个 JSON 对象。',
  ].join('\n');
}
