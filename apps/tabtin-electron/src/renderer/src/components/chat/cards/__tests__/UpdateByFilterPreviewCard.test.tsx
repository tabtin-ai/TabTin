import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'bulk.updateByFilter.previewTitle': '批量更新预览',
        'bulk.updateByFilter.matchedRows': `${opts?.count ?? ''} 行`,
        'bulk.updateByFilter.riskLow': '低风险操作',
        'bulk.updateByFilter.riskLowDesc': '影响行数较少，可放心执行。',
        'bulk.updateByFilter.riskMedium': '中风险操作',
        'bulk.updateByFilter.riskMediumDesc': `影响 ${opts?.count ?? ''} 行，将自动创建版本点。`,
        'bulk.updateByFilter.riskHigh': '高风险操作',
        'bulk.updateByFilter.riskHighDesc': `影响 ${opts?.count ?? ''} 行，请输入「确认更新」后执行。`,
        'bulk.updateByFilter.highRiskConfirmText': '确认更新',
        'bulk.updateByFilter.highRiskInputPlaceholder': '请输入「确认更新」以继续',
        'bulk.updateByFilter.estimatedDuration': `预计 ~${opts?.seconds ?? ''}秒`,
        'bulk.updateByFilter.estimatedDurationLong': `预计 ~${opts?.seconds ?? ''}秒，可在后台继续`,
        'bulk.updateByFilter.checkpointHint': '将自动创建版本点，可随时回退',
        'bulk.updateByFilter.confirm': '确认执行',
        'bulk.updateByFilter.cancel': '取消',
        'bulk.updateByFilter.committing': '正在执行批量更新…',
        'bulk.updateByFilter.commitSuccess': `批量更新完成，共更新 ${opts?.count ?? ''} 行。`,
        'bulk.updateByFilter.commitFailed': '批量更新提交失败',
        'bulk.updateByFilter.rejected': '超出单次更新上限',
        'bulk.updateByFilter.rejectedDesc': `匹配 ${opts?.count ?? ''} 行，超出单次上限 10000 行。请缩小筛选条件分批执行，或联系管理员。`,
        'bulk.updateByFilter.driftWarning': `实际更新行数与预检时有 ${opts?.ratio ?? ''}% 差异（预检 ${opts?.expected ?? ''} 行，实际 ${opts?.actual ?? ''} 行），建议核查数据。`,
        'bulk.updateByFilter.driftDismiss': '知道了',
        'bulk.updateByFilter.errorListTitle': `${opts?.count ?? ''} 条记录更新失败`,
        'bulk.updateByFilter.showMore': `展开更多 ${opts?.count ?? ''} 条`,
        'bulk.updateByFilter.showLess': '收起',
        'bulk.updateByFilter.samplePreview': '预览（最多 20 行样本）',
      }
      return map[key] ?? key
    },
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

import {
  UpdateByFilterPreviewCard,
  DriftWarningBanner,
  BatchErrorList,
  extractUpdateByFilterOutput,
} from '../UpdateByFilterPreviewCard'
import type { UpdateByFilterPreviewData } from '@tabtin/chat-client'

/* ═══════════════════════════════════════════════════════════════════
 * 场景 1: 预检渲染 (L35)
 * ═══════════════════════════════════════════════════════════════════ */

describe('UpdateByFilterPreviewCard — preflight rendering', () => {
  const basePreflight: UpdateByFilterPreviewData = {
    kind: 'update_by_filter_preview',
    phase: 'preflight',
    matched_total: 50,
    sample_records: [
      { id: 'r1', status: 'pending', name: 'Alice' },
      { id: 'r2', status: 'pending', name: 'Bob' },
    ],
    confirm_token: 'tok_abc123',
    estimated_duration_ms: 2500,
    requires_checkpoint: false,
  }

  it('renders title and matched row count', () => {
    render(<UpdateByFilterPreviewCard data={basePreflight} />)
    expect(screen.getByText('批量更新预览')).toBeDefined()
    expect(screen.getByText('50 行')).toBeDefined()
  })

  it('renders low-risk for matched_total < 200', () => {
    render(<UpdateByFilterPreviewCard data={basePreflight} />)
    expect(screen.getByText('低风险操作')).toBeDefined()
  })

  it('renders medium-risk for 200 ≤ matched_total < 1000', () => {
    render(
      <UpdateByFilterPreviewCard
        data={{ ...basePreflight, matched_total: 500, requires_checkpoint: true }}
      />,
    )
    expect(screen.getByText('中风险操作')).toBeDefined()
    expect(screen.getByText('将自动创建版本点，可随时回退')).toBeDefined()
  })

  it('renders high-risk with confirmation input for matched_total ≥ 1000', () => {
    render(
      <UpdateByFilterPreviewCard
        data={{ ...basePreflight, matched_total: 5000, requires_checkpoint: true }}
      />,
    )
    expect(screen.getByText('高风险操作')).toBeDefined()
    const input = screen.getByPlaceholderText('请输入「确认更新」以继续')
    expect(input).toBeDefined()
  })

  it('enables confirm button only after entering correct text for high-risk', () => {
    render(
      <UpdateByFilterPreviewCard
        data={{ ...basePreflight, matched_total: 5000, requires_checkpoint: true }}
      />,
    )
    const confirmBtn = screen.getByText('确认执行')
    expect(confirmBtn.closest('button')?.disabled).toBe(true)

    const input = screen.getByPlaceholderText('请输入「确认更新」以继续')
    fireEvent.change(input, { target: { value: '确认更新' } })
    expect(confirmBtn.closest('button')?.disabled).toBe(false)
  })

  it('renders sample records table', () => {
    render(<UpdateByFilterPreviewCard data={basePreflight} />)
    expect(screen.getByText('预览（最多 20 行样本）')).toBeDefined()
    expect(screen.getByText('Alice')).toBeDefined()
    expect(screen.getByText('Bob')).toBeDefined()
  })

  it('renders estimated duration', () => {
    render(<UpdateByFilterPreviewCard data={basePreflight} />)
    expect(screen.getByText('预计 ~3秒')).toBeDefined()
  })

  it('renders long duration hint for ≥ 30s', () => {
    render(
      <UpdateByFilterPreviewCard
        data={{ ...basePreflight, estimated_duration_ms: 45000 }}
      />,
    )
    expect(screen.getByText('预计 ~45秒，可在后台继续')).toBeDefined()
  })

  it('renders committed success state', () => {
    const committed: UpdateByFilterPreviewData = {
      ...basePreflight,
      phase: 'committed',
      updated_count: 50,
      drift_warning: false,
    }
    render(<UpdateByFilterPreviewCard data={committed} />)
    expect(screen.getByText('批量更新完成，共更新 50 行。')).toBeDefined()
  })
})

/* ═══════════════════════════════════════════════════════════════════
 * 场景 2: drift warning (L36)
 * ═══════════════════════════════════════════════════════════════════ */

describe('DriftWarningBanner — drift toast', () => {
  it('renders orange drift warning with ratio', () => {
    render(
      <DriftWarningBanner
        driftRatio={0.15}
        expected={100}
        actual={85}
      />,
    )
    expect(
      screen.getByText(
        '实际更新行数与预检时有 15% 差异（预检 100 行，实际 85 行），建议核查数据。',
      ),
    ).toBeDefined()
  })

  it('calls onDismiss when clicking dismiss button', () => {
    const onDismiss = vi.fn()
    render(
      <DriftWarningBanner
        driftRatio={0.15}
        expected={100}
        actual={85}
        onDismiss={onDismiss}
      />,
    )
    const dismissBtn = screen.getByRole('button', { name: '知道了' })
    fireEvent.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('renders drift warning within committed card', () => {
    const committed: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'committed',
      matched_total: 100,
      updated_count: 85,
      drift_warning: true,
      drift_ratio: 0.15,
    }
    render(<UpdateByFilterPreviewCard data={committed} />)
    expect(screen.getByRole('alert')).toBeDefined()
    expect(
      screen.getByText(/实际更新行数与预检时有 15% 差异/),
    ).toBeDefined()
  })
})

/* ═══════════════════════════════════════════════════════════════════
 * 场景 3: batch errors (L37)
 * ═══════════════════════════════════════════════════════════════════ */

describe('BatchErrorList — error display', () => {
  const threeErrors = [
    { record_id: 'rec_aaa11111', reason: '字段类型不匹配' },
    { record_id: 'rec_bbb22222', reason: '记录已被删除' },
    { record_id: 'rec_ccc33333', reason: '权限不足' },
  ]

  it('renders error list header with count', () => {
    render(<BatchErrorList errors={threeErrors} />)
    expect(screen.getByText('3 条记录更新失败')).toBeDefined()
  })

  it('renders all errors when ≤ 5', () => {
    render(<BatchErrorList errors={threeErrors} />)
    expect(screen.getByText('字段类型不匹配')).toBeDefined()
    expect(screen.getByText('记录已被删除')).toBeDefined()
    expect(screen.getByText('权限不足')).toBeDefined()
  })

  it('collapses errors when > 5, shows expand button', () => {
    const manyErrors = Array.from({ length: 8 }, (_, i) => ({
      record_id: `rec_${String(i).padStart(8, '0')}`,
      reason: `错误 ${i + 1}`,
    }))
    render(<BatchErrorList errors={manyErrors} />)
    expect(screen.getByText('展开更多 3 条')).toBeDefined()

    fireEvent.click(screen.getByText('展开更多 3 条'))
    expect(screen.getByText('收起')).toBeDefined()
    expect(screen.getByText('错误 8')).toBeDefined()
  })

  it('merges failed_record_ids into error list', () => {
    const errors = [
      { record_id: 'rec_aaa11111', reason: '字段类型不匹配' },
    ]
    render(
      <BatchErrorList
        errors={errors}
        failedRecordIds={['rec_aaa11111', 'rec_ddd44444']}
      />,
    )
    expect(screen.getByText('2 条记录更新失败')).toBeDefined()
  })

  it('renders errors in committed card', () => {
    const committed: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'committed',
      matched_total: 100,
      updated_count: 97,
      drift_warning: false,
      errors: threeErrors,
      failed_record_ids: ['rec_aaa11111', 'rec_bbb22222', 'rec_ccc33333'],
    }
    render(<UpdateByFilterPreviewCard data={committed} />)
    expect(screen.getByText('3 条记录更新失败')).toBeDefined()
  })

  it('returns null for empty errors', () => {
    const { container } = render(<BatchErrorList errors={[]} />)
    expect(container.innerHTML).toBe('')
  })
})

/* ═══════════════════════════════════════════════════════════════════
 * extractUpdateByFilterOutput
 * ═══════════════════════════════════════════════════════════════════ */

describe('extractUpdateByFilterOutput', () => {
  it('extracts preflight response', () => {
    const raw = {
      data: {
        matched_total: 200,
        sample_records: [{ id: 'r1' }],
        confirm_token: 'tok_xxx',
        estimated_duration_ms: 3000,
        requires_checkpoint: true,
      },
    }
    const result = extractUpdateByFilterOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('update_by_filter_preview')
    expect(result!.phase).toBe('preflight')
    expect(result!.matched_total).toBe(200)
    expect(result!.confirm_token).toBe('tok_xxx')
    expect(result!.requires_checkpoint).toBe(true)
  })

  it('extracts commit response with drift', () => {
    const raw = {
      data: {
        committed_ids: ['r1', 'r2'],
        matched_total: 100,
        updated_count: 85,
        drift_warning: true,
        drift_ratio: 0.15,
        drift_message_i18n_key: 'tabdata.a3_drift_warning_actual_lt_expected',
        operation_group_id: 'op_123',
        duration_ms: 1500,
      },
    }
    const result = extractUpdateByFilterOutput(raw)
    expect(result).not.toBeNull()
    expect(result!.phase).toBe('committed')
    expect(result!.updated_count).toBe(85)
    expect(result!.drift_warning).toBe(true)
    expect(result!.drift_ratio).toBe(0.15)
  })

  it('returns null for unrelated output', () => {
    expect(extractUpdateByFilterOutput({ data: { foo: 'bar' } })).toBeNull()
    expect(extractUpdateByFilterOutput(null)).toBeNull()
    expect(extractUpdateByFilterOutput('string')).toBeNull()
  })
})

/* ═══════════════════════════════════════════════════════════════════
 * P0 修复验证
 * ═══════════════════════════════════════════════════════════════════ */

describe('P0 fixes', () => {
  it('renders > 10000 rejection card', () => {
    const rejected: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'preflight',
      matched_total: 50000,
      confirm_token: 'tok_xxx',
    }
    render(<UpdateByFilterPreviewCard data={rejected} />)
    expect(screen.getByText('超出单次更新上限')).toBeDefined()
    expect(screen.getByText(/超出单次上限 10000 行/)).toBeDefined()
    expect(screen.queryByText('确认执行')).toBeNull()
  })

  it('renders cancel button in preflight', () => {
    const preflight: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'preflight',
      matched_total: 50,
      confirm_token: 'tok_abc',
    }
    render(<UpdateByFilterPreviewCard data={preflight} />)
    expect(screen.getByText('取消')).toBeDefined()
  })

  it('renders error phase with error banner', () => {
    const errorData: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'error',
      matched_total: 100,
    }
    render(<UpdateByFilterPreviewCard data={errorData} />)
    expect(screen.getByText('批量更新提交失败')).toBeDefined()
  })

  it('calls onConfirm with correct token on click', () => {
    const onConfirm = vi.fn()
    const preflight: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'preflight',
      matched_total: 50,
      confirm_token: 'tok_test_123',
    }
    render(<UpdateByFilterPreviewCard data={preflight} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText('确认执行'))
    expect(onConfirm).toHaveBeenCalledWith('tok_test_123')
  })

  it('calls onCancel when cancel button is clicked', () => {
    const onCancel = vi.fn()
    const preflight: UpdateByFilterPreviewData = {
      kind: 'update_by_filter_preview',
      phase: 'preflight',
      matched_total: 50,
      confirm_token: 'tok_xxx',
    }
    render(<UpdateByFilterPreviewCard data={preflight} onCancel={onCancel} />)
    fireEvent.click(screen.getByText('取消'))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
