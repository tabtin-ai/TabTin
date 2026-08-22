import { describe, expect, it } from 'vitest'
import { assessCloudSummaryQuality } from '../cloud-summary-quality.js'

describe('assessCloudSummaryQuality ', () => {
  it('accepts a normal Chinese resume summary', () => {
    const summary = [
      '姓名：冯起山',
      '工作经验：9 年 Java 后端开发，熟悉 Spring Boot、微服务与高并发。',
      '项目经历：负责电商交易链路重构，QPS 提升 3 倍。',
    ].join('\n')
    expect(assessCloudSummaryQuality(summary)).toEqual({ ok: true })
  })

  it('rejects table-stub-only summaries from Django table chunks', () => {
    expect(assessCloudSummaryQuality('[表格: ? 行]')).toEqual({
      ok: false,
      reason: 'table_stub_only',
    })
    expect(assessCloudSummaryQuality('[表格: 3 行]\n[表格: 12 行]')).toEqual({
      ok: false,
      reason: 'table_stub_only',
    })
  })

  it('rejects empty / whitespace', () => {
    expect(assessCloudSummaryQuality('')).toEqual({ ok: false, reason: 'empty' })
    expect(assessCloudSummaryQuality('   \n  ')).toEqual({ ok: false, reason: 'empty' })
  })

  it('rejects wave-garbled OCR residue', () => {
    expect(assessCloudSummaryQuality('~~~~\n~~~~\n~~~~')).toEqual({
      ok: false,
      reason: 'too_short',
    })
  })

  it('rejects garbled control-character text layers', () => {
    // 噪声占比 > 10% 才会被 computeTextLayerQuality 判 0
    const noise = '\u0000'.repeat(40)
    const body = `姓名工作经验项目经历${noise}`.repeat(3)
    expect(assessCloudSummaryQuality(body)).toEqual({
      ok: false,
      reason: 'garbled_text_layer',
    })
  })
})
