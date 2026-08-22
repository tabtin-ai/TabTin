import { Bot, type LucideProps } from 'lucide-react'
import { cn } from '@utils/cn'
import { ICON_SIZE, TEXT_COLOR } from '../registry/chatDesignTokens'

/**
 * 子代理编排的稳定语义符号。
 *
 * 派发、等待与收敛都保留同一枚机器人头像；状态变化交给文案与色彩表达，
 * 避免图标在机器人、Git 分叉和加载圆环之间切换造成语义漂移。
 */
export function SubagentOrchestrationIcon({ className, ...props }: LucideProps) {
  return (
    <Bot
      className={cn(ICON_SIZE.md, 'shrink-0', TEXT_COLOR.faint, className)}
      data-testid="subagent-orchestration-icon"
      aria-hidden
      {...props}
    />
  )
}
