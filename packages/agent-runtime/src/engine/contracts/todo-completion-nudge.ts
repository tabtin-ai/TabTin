/**
 * TodoCompletionNudgeProvider —— 宿主注入的 end_turn 待办收尾文案端口
 * （ Stage 2c）。
 *
 * 引擎只负责 gate 时机与 marker；中文 nudge 正文由宿主（agent-prompt）提供。
 */

export interface TodoNudgeItem {
  id: string;
  content: string;
  status: string;
}

export interface TodoCompletionNudgeProvider {
  buildNudgeBody(unfinished: readonly TodoNudgeItem[]): string;
  /**
   * 当前 mode 是否启用未完成 todo 催促（ Stage 4）。
   * 缺省视为不启用（须宿主显式打开，避免内核硬编码产品 mode 名）。
   */
  isEnabledForMode?(agentMode: string | undefined): boolean;
}
