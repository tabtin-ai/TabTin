export interface TaskRunResult {
  task_id: string
  disabled?: boolean
  reason?: string
}

export interface TaskRunFeedback {
  submitted: boolean
  message: string
}

export function getTaskRunFeedback(result: TaskRunResult): TaskRunFeedback {
  if (result.disabled && result.reason === 'task_governance_offline') {
    return {
      submitted: false,
      message: '该能力已下线，不会创建后台任务',
    }
  }

  const taskId = result.task_id ? result.task_id.slice(0, 8) : 'unknown'
  return {
    submitted: true,
    message: `任务已提交（task: ${taskId}）`,
  }
}
