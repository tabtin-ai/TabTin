/**
 * cloud-summary-quality — 云端 DocParse summary 注入前的质量门
 *
 * 背景：本地解析失败后 Host 会 `fetchCloudSummary`，后端偶发返回
 * `[表格: ? 行]` / 乱码伪文本却标 `status=ready`。原样注入 prompt 会让
 * Agent「看见附件但读不懂」。本模块在注入前做轻量判定。
 */

import { computeTextLayerQuality } from './text-layer-quality.js'

/** 仅表格占位、无实质正文（Django table chunk 常见 stub） */
const TABLE_STUB_ONLY_RE =
  /^(?:\s*\[表格[:：][^\]]*\]\s*)+$/u

/** 几乎只有波浪线 / 重复符号的 OCR 残影 */
const WAVE_GARBLED_RE = /^[\s~～\-—_·.•*]+$/u

export type CloudSummaryQualityVerdict =
  | { ok: true }
  | {
      ok: false
      reason: 'empty' | 'table_stub_only' | 'garbled_text_layer' | 'too_short'
    }

/**
 * 判定云端 summary 是否值得注入 Agent 上下文。
 *
 * - 空 / 过短 → 拒绝
 * - 全文只剩 `[表格: …]` stub → 拒绝（ 现场）
 * - 命中文本层质量门（与本地 PDF 同源）→ 拒绝
 */
export function assessCloudSummaryQuality(summary: string): CloudSummaryQualityVerdict {
  const trimmed = (summary ?? '').trim()
  if (!trimmed) return { ok: false, reason: 'empty' }

  if (TABLE_STUB_ONLY_RE.test(trimmed)) {
    return { ok: false, reason: 'table_stub_only' }
  }

  // 去掉表格 stub 行后再看有效正文
  const withoutTableStubs = trimmed
    .split('\n')
    .filter((line) => !/^\s*\[表格[:：][^\]]*\]\s*$/u.test(line))
    .join('\n')
    .trim()

  if (!withoutTableStubs) {
    return { ok: false, reason: 'table_stub_only' }
  }

  if (WAVE_GARBLED_RE.test(withoutTableStubs) || withoutTableStubs.length < 20) {
    return { ok: false, reason: 'too_short' }
  }

  if (computeTextLayerQuality(withoutTableStubs) < 0.3) {
    return { ok: false, reason: 'garbled_text_layer' }
  }

  return { ok: true }
}
