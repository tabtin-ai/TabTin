import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getTaskRunFeedback } from '../api/task-run-result'

const pageDir = dirname(fileURLToPath(import.meta.url))

describe('billing task governance offline contract', () => {
  it('classifies the compatible disabled response as an offline capability', () => {
    expect(
      getTaskRunFeedback({
        task_id: '',
        disabled: true,
        reason: 'task_governance_offline',
      })
    ).toEqual({
      submitted: false,
      message: '该能力已下线，不会创建后台任务',
    })
  })

  it('keeps the legacy task response compatible', () => {
    expect(getTaskRunFeedback({ task_id: '1234567890' })).toEqual({
      submitted: true,
      message: '任务已提交（task: 12345678）',
    })
  })

  it('requires every AdminDash trigger to handle the offline response', () => {
    for (const relativePath of [
      'ReconciliationPage.tsx',
      'StorageBillingPage.tsx',
      '../dashboard/hooks/useBillingDashboardData.ts',
    ]) {
      const source = readFileSync(join(pageDir, relativePath), 'utf8')
      expect(source).toContain('getTaskRunFeedback')
      expect(source).toContain('if (!feedback.submitted)')
    }
  })
})
