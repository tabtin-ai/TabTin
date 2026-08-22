/** SpaceCheckpoint.trigger 字段 → 中文展示文案 */
export function formatCheckpointTriggerLabel(trigger: string): string {
  switch (trigger) {
    case 'manual':
      return '手动快照'
    case 'agent_turn_done':
      return 'Agent 完成'
    case 'error_compensation':
      return '错误补偿'
    case 'agent_start':
      return 'Agent 开始'
    case 'agent_end':
      return 'Agent 结束'
    case 'auto':
      return '自动'
    default:
      return trigger || '未知'
  }
}
