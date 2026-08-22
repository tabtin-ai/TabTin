/**
 * Wave 6 续作 P0-4 (charter §4.4 / plan §Phase 6 验收 #1):
 *   TrackerRunStatusIndicator 恢复动作按钮单测。
 *
 * 业务约束:
 *   1. 失败 Run 必须把 trackerRun.recovery_actions 渲染为按钮列表
 *   2. 点击按钮触发对应动作(rerun → triggerTask, retry_with_model → triggerTask + override_model)
 *   3. 成功 Run 不渲染恢复按钮(只渲染"复制产物链接")
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TrackerRunMeta } from '@tabtin/chat-client'

const triggerTask = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
const toastInfo = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) {
        let v = opts.defaultValue as string
        for (const [k, val] of Object.entries(opts)) {
          if (k !== 'defaultValue') v = v.replace(`{{${k}}}`, String(val))
        }
        return v
      }
      return key
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
    info: (...args: unknown[]) => toastInfo(...args),
  },
}))

vi.mock('@services/trackerApi', () => ({
  triggerTask: (...args: unknown[]) => triggerTask(...args),
}))

// W3 改造：trackerArtifactMap.resolveArtifactAppFromSkill 走 contextRegistry 查询；
// buildArtifactLink 用 manifestResourceIdMap.getPrimaryContextRefTypeForApp
// 反查 manifest opens.types[0].type 作为 path `<type>` 字段。
vi.mock('@services/trackerArtifactMap', () => ({
  resolveArtifactAppFromSkill: (skillKey: string | null | undefined) => {
    if (!skillKey) return undefined
    const head = skillKey.toLowerCase().split(/[.-]/)[0]
    const KNOWN = new Set(['tabmemo', 'tabdoc', 'tabslide', 'tabcode', 'tabdata'])
    return KNOWN.has(head) ? head : undefined
  },
}))

vi.mock('@services/manifestResourceIdMap', () => ({
  getPrimaryContextRefTypeForApp: (appId: string) => {
    // 与 manifest opens.types[0].type 对齐 — ContextRefType（chat/types.ts）
    const APP_TO_TYPE: Record<string, string> = {
      tabmemo: 'memo',
      tabdoc: 'document',
      tabslide: 'slide',
      tabcode: 'code_file',
      tabdata: 'table',
    }
    return APP_TO_TYPE[appId]
  },
  getResourceIdEnvelopeKey: () => undefined,
}))

import { TrackerRunStatusIndicator } from '../TrackerRunStatusIndicator'

const baseFailedMeta: TrackerRunMeta = {
  run_id: 'run-1',
  run_index: 1,
  run_status: 'failed',
  tracker_id: 'tk-1',
  tracker_name: '整理上周 PR',
  tracker_origin: 'user_created',
  trigger_type: 'cron',
  trigger_context: {},
  skill_key: 'tabmemo.organize',
}

describe('TrackerRunStatusIndicator — recovery actions (Wave 6 续作 P0-4)', () => {
  beforeEach(() => {
    triggerTask.mockReset()
    triggerTask.mockResolvedValue({})
    toastSuccess.mockReset()
    toastError.mockReset()
    toastInfo.mockReset()
  })

  it('失败 Run 渲染 recovery_actions 按钮列表', () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      recovery_actions: [
        { kind: 'retry_with_model', label: '换 GPT-4 重试', model: 'gpt-4' },
        { kind: 'rerun', label: '重新运行' },
      ],
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    const container = screen.getByTestId('tracker-run-recovery-actions')
    expect(container).toBeTruthy()
    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0].textContent).toContain('换 GPT-4 重试')
    expect(buttons[1].textContent).toContain('重新运行')
  })

  it('点击 rerun 按钮 → 调 triggerTask(tracker_id) + 成功 toast', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      recovery_actions: [{ kind: 'rerun', label: '重新运行' }],
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-recovery-action-rerun'))
    await waitFor(() => expect(triggerTask).toHaveBeenCalledWith('tk-1'))
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('点击 retry_with_model → 调 triggerTask 带 override_model', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      recovery_actions: [{ kind: 'retry_with_model', label: '换 GPT-4', model: 'gpt-4' }],
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-recovery-action-retry_with_model'))
    await waitFor(() => expect(triggerTask).toHaveBeenCalledWith('tk-1', { override_model: 'gpt-4' }))
  })

  it('成功 Run 不渲染 recovery_actions 容器(成功状态没有 recovery_actions)', () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      recovery_actions: [{ kind: 'rerun', label: '重新运行' }],  // 即使后端意外返回也不渲染
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    expect(screen.queryByTestId('tracker-run-recovery-actions')).toBeNull()
  })

  it('失败 Run 但无 recovery_actions → 不渲染容器', () => {
    render(<TrackerRunStatusIndicator trackerRun={baseFailedMeta} />)
    expect(screen.queryByTestId('tracker-run-recovery-actions')).toBeNull()
  })

  it('点击 switch_agent → 不调 triggerTask,只 toast.info', () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      recovery_actions: [{ kind: 'switch_agent', label: '换一个 Agent' }],
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-recovery-action-switch_agent'))
    expect(triggerTask).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalled()
  })
})

describe('TrackerRunStatusIndicator — 复制产物链接(Wave 6 主实施回归)', () => {
  it('成功 Run 渲染"复制产物链接"按钮', () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabmemo.organize',
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    expect(screen.getByTestId('tracker-run-copy-artifact-link')).toBeTruthy()
  })

  it('skill_key 不命中 → 不渲染复制按钮', () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'unknown-skill',
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    expect(screen.queryByTestId('tracker-run-copy-artifact-link')).toBeNull()
  })
})

// =============================================================================
// charter §4.4 "1 步可达":
//   buildArtifactLink 必须真消费 trackerRun.artifact_ref(snake_case),把
//   memo_id / doc_id / slide_id / code_path / record_ids / artifact_id 塞进
//   产物 deep link query（W3 形态：tabtin://resource/<type>/<id>?hint=<app>&...）。
//   本测试守护字段不死、形态契约稳定。
// =============================================================================
describe('TrackerRunStatusIndicator — 复制产物链接含 artifact_ref (NEW-P0-3 §4.4)', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    })
  })

  function getLinkFromButton(): string | null {
    // 通过 mock clipboard.writeText 取链接
    const writeText = (navigator.clipboard as any).writeText as ReturnType<typeof vi.fn>
    return writeText.mock.calls[0]?.[0] ?? null
  }

  it('artifact_ref.memo_id → 链接含 memoId', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabmemo.organize',
      artifact_ref: { memo_id: 'mem_xyz' },
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-copy-artifact-link'))
    await waitFor(() => expect(getLinkFromButton()).not.toBeNull())
    const link = getLinkFromButton()!
    // W3 改造（RFC §10.3）：path 形态 tabtin://resource/<type>/<id>?hint=<app>&...
    expect(link.startsWith('tabtin://resource/memo/')).toBe(true)
    expect(link).toContain('hint=tabmemo')
    expect(link).toContain('memoId=mem_xyz')
    expect(link).toContain('run=run-1')
    expect(link).toContain('tracker=tk-1')
  })

  it('artifact_ref.doc_id → 链接含 docId', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabdoc.write',
      artifact_ref: { doc_id: 'doc_42' },
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-copy-artifact-link'))
    await waitFor(() => expect(getLinkFromButton()).not.toBeNull())
    expect(getLinkFromButton()!).toContain('docId=doc_42')
  })

  it('artifact_ref.code_path 含特殊字符 → URL 编码进 codePath', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabcode.edit',
      artifact_ref: { code_path: 'src/foo bar.py' },
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-copy-artifact-link'))
    await waitFor(() => expect(getLinkFromButton()).not.toBeNull())
    const link = getLinkFromButton()!
    // URLSearchParams 应已对值做百分号编码
    expect(link).toMatch(/codePath=src%2Ffoo[+%20]bar\.py/)
  })

  it('artifact_ref.record_ids 数组 → 链接含 recordIds=逗号分隔', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabdata.append_row',
      artifact_ref: { record_ids: ['r1', 'r2', 'r3'] },
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-copy-artifact-link'))
    await waitFor(() => expect(getLinkFromButton()).not.toBeNull())
    const link = getLinkFromButton()!
    expect(link).toMatch(/recordIds=r1%2Cr2%2Cr3|recordIds=r1,r2,r3/)
  })

  it('artifact_ref 缺失 → 链接只含 run + tracker(向后兼容)', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabmemo.organize',
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-copy-artifact-link'))
    await waitFor(() => expect(getLinkFromButton()).not.toBeNull())
    const link = getLinkFromButton()!
    expect(link).toContain('run=run-1')
    expect(link).toContain('tracker=tk-1')
    expect(link).not.toContain('memoId')
    expect(link).not.toContain('docId')
  })

  it('多产物字段同时存在 → 全部塞进链接', async () => {
    const meta: TrackerRunMeta = {
      ...baseFailedMeta,
      run_status: 'success',
      skill_key: 'tabmemo.organize',
      artifact_ref: {
        memo_id: 'mem_1',
        artifact_id: 'art_2',
      },
    }
    render(<TrackerRunStatusIndicator trackerRun={meta} />)
    fireEvent.click(screen.getByTestId('tracker-run-copy-artifact-link'))
    await waitFor(() => expect(getLinkFromButton()).not.toBeNull())
    const link = getLinkFromButton()!
    expect(link).toContain('memoId=mem_1')
    expect(link).toContain('artifactId=art_2')
  })
})
