/**
 * SubagentInlineDetail — 子 Agent「就地展开」容器（点对话里那一行 → 行下方缩进展开执行流）
 *
 * **形态：下沉展开区**。下沉底色（BG.codeSunken）+ 圆角，紧贴派发行下方就地展开。
 * 早期版本用「淡左竖线 + 缩进」表达子线程延续，但底色太淡、辨识度不足（用户反馈
 * 「背景不够明显」），故改用更明显的下沉底色。内部不加阴影——展开内容保持干净平整，
 * 只靠底色与外层列表卡片区分。
 * 配套 SubagentDetailPane 传 `compactHeader`：去掉重复身份的 header，只留一排操作图标。
 * 被对话内派发标记（SubagentAggregateView）+ registry 兜底单卡（SubagentProgressCard）共用。
 *
 * 高度策略：内容完整展开，由父对话的滚动容器统一承接滚动；工作台 tab 仍保留
 * 自己的固定视口。这样行内详情没有第二层滚动，也不会截断较长的子 Agent 消息。
 *
 * isPaneActive 恒 true：展开即活跃，触发 jsonl bootstrap + 实时订阅；收起时整个组件
 * unmount，订阅随之停止（调用方手风琴单选保证同时只有一个在跑）。
 */

import React from 'react'
import { cn } from '@utils/cn'
import { CARD_RADIUS, BG } from '../registry/chatDesignTokens'
import { SubagentDetailPane } from './SubagentDetailPane'

interface SubagentInlineDetailProps {
  subagentRunId: string
  parentSessionId: string
  parentToolCallId?: string
  /** 收起回调——「在工作台标签打开」后调用收起 inline；平时收起走「再点对话里那一行」。 */
  onClose: () => void
}

export const SubagentInlineDetail: React.FC<SubagentInlineDetailProps> = ({
  subagentRunId,
  parentSessionId,
  parentToolCallId,
  onClose,
}) => (
  <div
    className={cn(
      // 就地展开区：下沉底色（BG.codeSunken）+ 圆角，紧贴派发行下方（mt-0.5）展开。
      // 不加内阴影——展开内容内部保持干净平整，只靠底色与外层卡片区分。
      // 高度随完整消息流自然增长，滚动交给父对话。
      'mt-0.5 flex min-h-0 flex-col overflow-visible',
      CARD_RADIUS,
      BG.codeSunken,
      'animate-in fade-in slide-in-from-top-1 duration-200',
    )}
    data-testid={`subagent-inline-detail-${subagentRunId}`}
  >
    <SubagentDetailPane
      subagentRunId={subagentRunId}
      parentSessionId={parentSessionId}
      parentToolCallId={parentToolCallId}
      isPaneActive
      allowOpenInTab
      compactHeader
      onClose={onClose}
    />
  </div>
)

SubagentInlineDetail.displayName = 'SubagentInlineDetail'
