/**
 * Agent Debug 技术详情里的事件类型 / 名称中文标签。
 * 未知值回退原文，便于兼容后端新增短名。
 */

const EVENT_TYPE_LABELS: Record<string, string> = {
  node: '节点',
  route: '路由',
  llm: '模型',
  tool: '工具',
  action_result: '工具结果',
  prompt_snapshot: '提示词快照',
  error: '错误',
  context: '上下文',
  lifecycle: '生命周期',
  user: '用户',
  system_notice: '系统通知',
  step: '步骤',
  llm_request: '模型请求',
  audit_cap: '能力审计',
  assistant: '助手',
  thinking: '分析',
}

const EVENT_NAME_LABELS: Record<string, string> = {
  start: '开始',
  end: '结束',
  turn_start: '轮次开始',
  turn_end: '轮次结束',
  user: '用户消息',
  assistant: '助手回复',
  thinking: '分析任务',
  llm_timing: '模型耗时',
  llm_request: '模型请求',
  audit_cap: '能力审计',
  tool_started: '工具开始',
  tool_completed: '工具完成',
  tool_progress: '工具进度',
  started: '已开始',
  completed: '已完成',
  failed: '失败',
  progress: '进行中',
  done: '完成',
}

export function getEventTypeLabel(eventType: string): string {
  return EVENT_TYPE_LABELS[eventType] || eventType
}

export function getEventNameLabel(name: string): string {
  return EVENT_NAME_LABELS[name] || name
}

export function getEventPhaseLabel(phase: 'start' | 'end'): string {
  return phase === 'end' ? '结束' : '开始'
}
