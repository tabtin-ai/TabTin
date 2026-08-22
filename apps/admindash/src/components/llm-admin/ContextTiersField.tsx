/**
 * ContextTiersField — LLM 模型「上下文档位」编辑器
 *
 * 用于在 llm-admin 模型创建/编辑表单里管理 `custom_billing_config.tiered_pricing.tiers`，
 * 支持 ZenMux 长上下文（1M Beta）等场景。
 *
 * 数据契约：
 *   - 用户在 UI 编辑的是 `TierFormItem[]`（字符串字段，便于受控输入），
 *     提交前通过 `serializeTiersToConfig` 转回 `custom_billing_config.tiered_pricing.tiers[]`。
 *   - 反向：`parseTiersFromConfig` 从已存在的 `custom_billing_config` 解析出表单项。
 *
 * 行为：
 *   - 简单模式：每档配 input/output 单价（运营按需配缓存价）
 *   - 进阶模式：每档可额外配 `applies_above_tokens` + `over_*_price_per_1k`，
 *     表达 ZenMux 那种「档内分裂：≤200K 标准价、超出部分加价」语义
 *
 * UI 风格沿用 admindash 现有 input / button / Badge 组件。
 *
 */

import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Info,
  Plus,
  Trash2,
  Wand2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface TierFormItem {
  /** 档位 ID（如 'standard' / 'long_1m'） */
  id: string
  /** 显示文案（前端展示用） */
  label: string
  /** 是否默认档（一组里有且仅一个 true） */
  is_default: boolean
  /** 该档最大输入 token 数（数字字符串，提交时 parse） */
  max_input_tokens: string
  /** 标签，逗号分隔（'beta,preview' → ['beta','preview']） */
  tags_csv: string
  /** 透传给上游的 Header（key=value，每行一对） */
  extra_headers_text: string
  /** 该档基础输入单价（每 1K token） */
  input_price_per_1k: string
  /** 该档基础输出单价（每 1K token） */
  output_price_per_1k: string
  /** 缓存读单价（可选） */
  cache_hit_price_per_1k: string
  /** 缓存写单价（可选） */
  cache_creation_price_per_1k: string
  /** 「档内分裂」阈值：超出此 token 数的部分按 over_* 单价计算 */
  applies_above_tokens: string
  over_input_price_per_1k: string
  over_output_price_per_1k: string
}

const EMPTY_TIER: TierFormItem = {
  id: '',
  label: '',
  is_default: false,
  max_input_tokens: '',
  tags_csv: '',
  extra_headers_text: '',
  input_price_per_1k: '',
  output_price_per_1k: '',
  cache_hit_price_per_1k: '',
  cache_creation_price_per_1k: '',
  applies_above_tokens: '',
  over_input_price_per_1k: '',
  over_output_price_per_1k: '',
}

/**
 * 把 UI 表单项序列化回 custom_billing_config.tiered_pricing.tiers[]。
 *
 * - 空字符串字段不写入（保持配置干净）
 * - extra_headers_text 按 "key: value" 或 "key=value" 解析，每行一对，忽略空行
 * - 校验失败的项也会写入（让运营能看到错），由后端 _validate_tiered_pricing 拦截
 */
export function serializeTiersToConfig(tiers: TierFormItem[]): Record<string, unknown>[] {
  return tiers.map((t) => {
    const out: Record<string, unknown> = {}
    if (t.id.trim()) out.id = t.id.trim()
    if (t.label.trim()) out.label = t.label.trim()
    if (t.is_default) out.is_default = true

    const maxIn = Number(t.max_input_tokens)
    if (Number.isFinite(maxIn) && maxIn > 0) out.max_input_tokens = Math.floor(maxIn)

    const tags = t.tags_csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (tags.length) out.tags = tags

    const headers = parseHeadersText(t.extra_headers_text)
    if (Object.keys(headers).length) out.extra_headers = headers

    for (const [field, raw] of [
      ['input_price_per_1k', t.input_price_per_1k],
      ['output_price_per_1k', t.output_price_per_1k],
      ['cache_hit_price_per_1k', t.cache_hit_price_per_1k],
      ['cache_creation_price_per_1k', t.cache_creation_price_per_1k],
      ['over_input_price_per_1k', t.over_input_price_per_1k],
      ['over_output_price_per_1k', t.over_output_price_per_1k],
    ] as const) {
      const num = Number(raw)
      if (raw.trim() && Number.isFinite(num) && num >= 0) out[field] = num
    }

    const above = Number(t.applies_above_tokens)
    if (t.applies_above_tokens.trim() && Number.isFinite(above) && above >= 0) {
      out.applies_above_tokens = Math.floor(above)
    }

    return out
  })
}

/** 反向：从已存在的 tiers 数组还原成表单项。 */
export function parseTiersFromConfig(tiers: unknown): TierFormItem[] {
  if (!Array.isArray(tiers)) return []
  return tiers.map((tier, idx) => {
    const t = (tier && typeof tier === 'object' ? (tier as Record<string, unknown>) : {})
    const headers = (t.extra_headers && typeof t.extra_headers === 'object'
      ? (t.extra_headers as Record<string, unknown>)
      : {})
    return {
      id: typeof t.id === 'string' ? t.id : `tier_${idx}`,
      label: typeof t.label === 'string' ? t.label : `档位 ${idx + 1}`,
      is_default: t.is_default === true,
      max_input_tokens:
        typeof t.max_input_tokens === 'number' ? String(t.max_input_tokens) : '',
      tags_csv: Array.isArray(t.tags) ? (t.tags as unknown[]).join(',') : '',
      extra_headers_text: Object.entries(headers)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join('\n'),
      input_price_per_1k: numToStr(t.input_price_per_1k),
      output_price_per_1k: numToStr(t.output_price_per_1k),
      cache_hit_price_per_1k: numToStr(t.cache_hit_price_per_1k),
      cache_creation_price_per_1k: numToStr(t.cache_creation_price_per_1k),
      applies_above_tokens: numToStr(t.applies_above_tokens),
      over_input_price_per_1k: numToStr(t.over_input_price_per_1k),
      over_output_price_per_1k: numToStr(t.over_output_price_per_1k),
    }
  })
}

function numToStr(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return v
  return ''
}

function parseHeadersText(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      // 兼容 "key: value" 和 "key=value"
      const sepIdx = line.indexOf(':')
      const eqIdx = line.indexOf('=')
      const idx = sepIdx >= 0 && (eqIdx < 0 || sepIdx < eqIdx) ? sepIdx : eqIdx
      if (idx <= 0) return
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key && value) out[key] = value
    })
  return out
}

/**
 * 为 ZenMux Anthropic 1M 长上下文场景生成档位预设。
 *
 * 默认搭一个 standard（200K）+ long_1m（1M, Beta）双档结构，
 * 单价留空让运营自己核对，但 extra_headers / applies_above_tokens 等
 * 关键字段已就位。
 */
export function buildZenMuxLongContextPreset(): TierFormItem[] {
  return [
    {
      id: 'standard',
      label: '标准 (200K)',
      is_default: true,
      max_input_tokens: '200000',
      tags_csv: '',
      extra_headers_text: '',
      input_price_per_1k: '',
      output_price_per_1k: '',
      cache_hit_price_per_1k: '',
      cache_creation_price_per_1k: '',
      applies_above_tokens: '',
      over_input_price_per_1k: '',
      over_output_price_per_1k: '',
    },
    {
      id: 'long_1m',
      label: '长上下文 (1M, Beta)',
      is_default: false,
      max_input_tokens: '1000000',
      tags_csv: 'beta',
      extra_headers_text: 'anthropic-beta: context-1m-2025-08-07',
      input_price_per_1k: '',
      output_price_per_1k: '',
      cache_hit_price_per_1k: '',
      cache_creation_price_per_1k: '',
      applies_above_tokens: '200000',
      over_input_price_per_1k: '',
      over_output_price_per_1k: '',
    },
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// 实时校验
// ─────────────────────────────────────────────────────────────────────────────
//
// 设计目标：把后端 `_validate_tiered_pricing` 的规则在前端镜像一份，让运营
// 在输入时立即看到红边 + 错误文案，不再等提交后才发现。
//
// 规则按字段而非按行组织，避免跨字段错误信息混在一起；UI 渲染时用
// `getTierIssuesForField(...)` 按字段抓出来高亮对应的 Input。
//
// **规则与后端对齐说明**：
//   - id 唯一性、is_default 唯一性、max_input_tokens 严格递增
//     → 后端 _validate_tiered_pricing 同款拒绝
//   - extra_headers 格式、over_*_price 与 applies_above_tokens 的搭配
//     → 后端不强制（仍能存），但配错就是「无效配置」，前端做 warning
//
// 凡是后端会拒绝的列 `level: 'error'`；凡是合法但运营大概率没这么想的列
// `level: 'warning'`。两者 UI 表现一致（红/黄色），但 hasError 仅统计 error。

export type TierIssueField =
  | 'id'
  | 'is_default'
  | 'max_input_tokens'
  | 'extra_headers'
  | 'applies_above_tokens'
  | 'over_pricing'
  | 'general'

export interface TierIssue {
  field: TierIssueField
  level: 'error' | 'warning'
  message: string
}

export interface TiersValidationResult {
  /** 与 tiers 数组同序对齐：rowIssues[i] = 第 i 档的问题列表 */
  rowIssues: TierIssue[][]
  /** 影响整个表的问题（如「未指定默认档」） */
  globalIssues: TierIssue[]
  /** 是否包含至少一条 error（提交按钮可据此 disable） */
  hasError: boolean
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/

/**
 * 把当前所有 tiers 同步算一遍校验。纯函数，无副作用，输入相同则输出相同。
 *
 * 复杂度 O(n)（n = tiers 数）。每次 onChange 触发的渲染里跑 useMemo 调用，
 * 现实场景下 tiers 通常 ≤ 5，开销可忽略。
 */
export function validateTiers(tiers: TierFormItem[]): TiersValidationResult {
  const rowIssues: TierIssue[][] = tiers.map(() => [])
  const globalIssues: TierIssue[] = []

  // ─── id 校验 ───
  // 收集所有非空 id 的索引，用于检测重复
  const idIndex = new Map<string, number[]>()
  for (let i = 0; i < tiers.length; i++) {
    const id = tiers[i].id.trim()
    if (!id) {
      rowIssues[i].push({
        field: 'id',
        level: 'error',
        message: '档位 ID 不能为空',
      })
      continue
    }
    if (!ID_PATTERN.test(id)) {
      rowIssues[i].push({
        field: 'id',
        level: 'error',
        message: '档位 ID 仅允许字母、数字、下划线、横线（如 long_1m）',
      })
    }
    const list = idIndex.get(id) ?? []
    list.push(i)
    idIndex.set(id, list)
  }
  for (const [id, indices] of idIndex.entries()) {
    if (indices.length > 1) {
      const others = indices.map((idx) => `档位 ${idx + 1}`).join(' / ')
      for (const idx of indices) {
        rowIssues[idx].push({
          field: 'id',
          level: 'error',
          message: `档位 ID "${id}" 重复（出现在 ${others}）`,
        })
      }
    }
  }

  // ─── is_default 唯一性 ───
  const defaultIndices = tiers
    .map((t, i) => (t.is_default ? i : -1))
    .filter((i) => i >= 0)
  if (defaultIndices.length > 1) {
    for (const idx of defaultIndices) {
      rowIssues[idx].push({
        field: 'is_default',
        level: 'error',
        message: `存在 ${defaultIndices.length} 个默认档（仅允许 1 个）`,
      })
    }
  } else if (defaultIndices.length === 0 && tiers.length > 0) {
    globalIssues.push({
      field: 'is_default',
      level: 'warning',
      message: '未指定默认档 — 运行时会自动以第一档为默认（可继续提交）',
    })
  }

  // ─── max_input_tokens 严格递增 ───
  // 仅对相邻两档比较；策略与后端 _validate_tiered_pricing 的 prev_min 校验对齐。
  // 前一档为空（未填）时跳过比较，避免误报。
  let prevMax: number | null = null
  for (let i = 0; i < tiers.length; i++) {
    const raw = tiers[i].max_input_tokens.trim()
    if (!raw) {
      // 空值不算错（运营可能稍后补填）
      continue
    }
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0 || !Number.isInteger(num)) {
      rowIssues[i].push({
        field: 'max_input_tokens',
        level: 'error',
        message: '最大输入 Token 必须是正整数',
      })
      // 解析失败时不参与递增检查，避免连锁误报
      continue
    }
    if (prevMax !== null && num <= prevMax) {
      rowIssues[i].push({
        field: 'max_input_tokens',
        level: 'error',
        message: `最大输入 Token 必须严格大于前一档（${prevMax.toLocaleString()}）`,
      })
    }
    prevMax = num
  }

  // ─── extra_headers 格式 ───
  for (let i = 0; i < tiers.length; i++) {
    const text = tiers[i].extra_headers_text
    if (!text.trim()) continue
    const parsed = parseHeadersText(text)
    const nonEmptyLines = text.split(/\r?\n/).filter((line) => line.trim()).length
    if (nonEmptyLines > 0 && Object.keys(parsed).length === 0) {
      rowIssues[i].push({
        field: 'extra_headers',
        level: 'error',
        message: '透传 Header 格式错误：每行需 "key: value" 或 "key=value"',
      })
    } else if (Object.keys(parsed).length < nonEmptyLines) {
      rowIssues[i].push({
        field: 'extra_headers',
        level: 'warning',
        message: `${nonEmptyLines - Object.keys(parsed).length} 行 Header 解析失败（已忽略），请检查格式`,
      })
    }
  }

  // ─── applies_above_tokens 与 over_*_price 的搭配 ───
  // 这是档内分裂计费的核心契约：阈值与超阈值价必须成对出现，否则配置无效。
  // 后端不会拒绝（仍走基础价），但运营大概率以为已生效，所以前端要 warn。
  for (let i = 0; i < tiers.length; i++) {
    const t = tiers[i]
    const hasAbove = !!t.applies_above_tokens.trim()
    const hasOverIn = !!t.over_input_price_per_1k.trim()
    const hasOverOut = !!t.over_output_price_per_1k.trim()

    if (hasAbove && !hasOverIn && !hasOverOut) {
      rowIssues[i].push({
        field: 'over_pricing',
        level: 'warning',
        message: '配置了阈值但未配超阈值单价 — 档内分裂不会生效',
      })
    } else if (!hasAbove && (hasOverIn || hasOverOut)) {
      rowIssues[i].push({
        field: 'applies_above_tokens',
        level: 'warning',
        message: '配置了超阈值单价但未配阈值 — 档内分裂不会生效',
      })
    }

    if (hasAbove) {
      const above = Number(t.applies_above_tokens)
      if (!Number.isFinite(above) || above < 0 || !Number.isInteger(above)) {
        rowIssues[i].push({
          field: 'applies_above_tokens',
          level: 'error',
          message: '阈值必须是非负整数',
        })
      }
    }
  }

  const hasError =
    globalIssues.some((i) => i.level === 'error') ||
    rowIssues.some((row) => row.some((i) => i.level === 'error'))

  return { rowIssues, globalIssues, hasError }
}

/** 抓出某行某字段的 issue（UI 用于决定 Input 是否标红）。 */
function getTierIssuesForField(
  rowIssues: TierIssue[],
  field: TierIssueField,
): TierIssue[] {
  return rowIssues.filter((i) => i.field === field)
}

/** 按 issue 级别推一个 Tailwind 边框颜色 class。`null` = 没问题 = 不动样式。 */
function borderClassForIssues(issues: TierIssue[]): string | null {
  if (issues.length === 0) return null
  const hasError = issues.some((i) => i.level === 'error')
  return hasError
    ? 'border-destructive focus-visible:ring-destructive/40'
    : 'border-warning focus-visible:ring-warning/40'
}

interface ContextTiersFieldProps {
  value: TierFormItem[]
  onChange: (next: TierFormItem[]) => void
  /** 仅在创建模型时显示「ZenMux 1M 预设」按钮 */
  showZenmuxPreset?: boolean
}

export function ContextTiersField({ value, onChange, showZenmuxPreset = true }: ContextTiersFieldProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  // 实时校验：每次 value 变就重算。tiers 数 ≤ 5 时复杂度可忽略。
  const validation = useMemo(() => validateTiers(value), [value])

  const toggleExpand = (idx: number) => {
    const next = new Set(expanded)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    setExpanded(next)
  }

  const updateAt = (idx: number, patch: Partial<TierFormItem>) => {
    const next = value.map((t, i) => (i === idx ? { ...t, ...patch } : t))
    // is_default 互斥：若设当前为 true，其他档自动转 false
    if (patch.is_default === true) {
      for (let i = 0; i < next.length; i++) {
        if (i !== idx) next[i] = { ...next[i], is_default: false }
      }
    }
    onChange(next)
  }

  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx))
    const next = new Set(expanded)
    next.delete(idx)
    setExpanded(next)
  }

  const addEmpty = () => {
    const idx = value.length
    onChange([
      ...value,
      {
        ...EMPTY_TIER,
        id: `tier_${idx + 1}`,
        label: `档位 ${idx + 1}`,
        is_default: value.length === 0,
      },
    ])
    setExpanded(new Set([...expanded, idx]))
  }

  const applyPreset = () => {
    onChange(buildZenMuxLongContextPreset())
    setExpanded(new Set([0, 1]))
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium">上下文档位（Context Tiers）</div>
          <div className="text-xs text-muted-foreground">
            为同一模型配置多种上下文长度（如 ZenMux 1M）。空 = 不启用档位，所有请求走默认行为。
          </div>
        </div>
        <div className="flex items-center gap-2">
          {showZenmuxPreset && (
            <Button variant="outline" size="sm" type="button" onClick={applyPreset}>
              <Wand2 className="h-3.5 w-3.5 mr-1" />
              ZenMux 1M 预设
            </Button>
          )}
          <Button variant="outline" size="sm" type="button" onClick={addEmpty}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            添加档位
          </Button>
        </div>
      </div>

      {value.length === 0 && (
        <div className="rounded border border-dashed border-muted px-4 py-6 text-center text-sm text-muted-foreground">
          未配置档位 — 用户将看不到档位芯片，所有请求按模型基础参数发送。
        </div>
      )}

      {/* 整体提示：未指定默认档之类的全局问题（不影响每行红边） */}
      {validation.globalIssues.length > 0 && (
        <div className="space-y-1">
          {validation.globalIssues.map((issue, i) => (
            <IssueLine key={`g-${i}`} issue={issue} />
          ))}
        </div>
      )}

      {/* 顶部汇总：当存在 error 时给一个明确的"提交会被后端拒绝"的提示，
          避免用户看完每行红边还要回滚找哪些字段改过。 */}
      {validation.hasError && (
        <div className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive flex items-start gap-2">
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <span>
            档位配置有错误，提交时后端会拒绝。请修复下方标红字段。
          </span>
        </div>
      )}

      {value.map((tier, idx) => {
        const isExpanded = expanded.has(idx)
        const rowIssues = validation.rowIssues[idx] ?? []
        const idIssues = getTierIssuesForField(rowIssues, 'id')
        const maxInputIssues = getTierIssuesForField(rowIssues, 'max_input_tokens')
        const headerIssues = getTierIssuesForField(rowIssues, 'extra_headers')
        const aboveIssues = getTierIssuesForField(rowIssues, 'applies_above_tokens')
        const overIssues = getTierIssuesForField(rowIssues, 'over_pricing')
        const isDefaultIssues = getTierIssuesForField(rowIssues, 'is_default')
        const rowHasError = rowIssues.some((i) => i.level === 'error')
        const rowHasWarning = !rowHasError && rowIssues.some((i) => i.level === 'warning')

        return (
          <div
            key={idx}
            className={cn(
              'rounded border bg-muted/20 p-3 space-y-2 transition-colors',
              rowHasError
                ? 'border-destructive/60'
                : rowHasWarning
                  ? 'border-warning/60'
                  : 'border-border/60',
            )}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => toggleExpand(idx)}
                className="p-1 -ml-1 rounded hover:bg-muted"
                aria-label={isExpanded ? '收起' : '展开'}
              >
                {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
              <Input
                className={cn('max-w-[180px]', borderClassForIssues(idIssues))}
                placeholder="ID, 如 long_1m"
                value={tier.id}
                onChange={(e) => updateAt(idx, { id: e.target.value })}
                aria-invalid={idIssues.some((i) => i.level === 'error') || undefined}
              />
              <Input
                className="flex-1"
                placeholder="显示文案，如 长上下文 (1M, Beta)"
                value={tier.label}
                onChange={(e) => updateAt(idx, { label: e.target.value })}
              />
              <label
                className={cn(
                  'flex items-center gap-1.5 text-xs cursor-pointer select-none whitespace-nowrap',
                  isDefaultIssues.some((i) => i.level === 'error') && 'text-destructive',
                )}
              >
                <input
                  type="checkbox"
                  checked={tier.is_default}
                  onChange={(e) => updateAt(idx, { is_default: e.target.checked })}
                />
                <span>默认</span>
              </label>
              {tier.is_default && <Badge variant="secondary">默认档</Badge>}
              <Button variant="ghost" size="sm" type="button" onClick={() => removeAt(idx)} className="text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>

            {isExpanded && (
              <div className="grid grid-cols-2 gap-2 pl-7">
                <FieldRow label="最大输入 Token" hint="如 200000 / 1000000">
                  <Input
                    type="number"
                    className={borderClassForIssues(maxInputIssues) ?? undefined}
                    value={tier.max_input_tokens}
                    onChange={(e) => updateAt(idx, { max_input_tokens: e.target.value })}
                    aria-invalid={maxInputIssues.some((i) => i.level === 'error') || undefined}
                  />
                </FieldRow>
                <FieldRow label="标签（逗号分隔）" hint="如 beta,preview">
                  <Input
                    value={tier.tags_csv}
                    onChange={(e) => updateAt(idx, { tags_csv: e.target.value })}
                  />
                </FieldRow>
                <FieldRow
                  label="输入单价 (元/1K Token)"
                  hint="留空 = 复用模型基础单价"
                >
                  <Input
                    type="number"
                    step="0.000001"
                    value={tier.input_price_per_1k}
                    onChange={(e) => updateAt(idx, { input_price_per_1k: e.target.value })}
                  />
                </FieldRow>
                <FieldRow label="输出单价 (元/1K Token)" hint="留空 = 复用模型基础单价">
                  <Input
                    type="number"
                    step="0.000001"
                    value={tier.output_price_per_1k}
                    onChange={(e) => updateAt(idx, { output_price_per_1k: e.target.value })}
                  />
                </FieldRow>
                <FieldRow label="缓存读单价 (元/1K)" hint="留空走 Provider 默认折扣">
                  <Input
                    type="number"
                    step="0.000001"
                    value={tier.cache_hit_price_per_1k}
                    onChange={(e) => updateAt(idx, { cache_hit_price_per_1k: e.target.value })}
                  />
                </FieldRow>
                <FieldRow label="缓存写单价 (元/1K)" hint="留空走 Provider 默认折扣">
                  <Input
                    type="number"
                    step="0.000001"
                    value={tier.cache_creation_price_per_1k}
                    onChange={(e) =>
                      updateAt(idx, { cache_creation_price_per_1k: e.target.value })
                    }
                  />
                </FieldRow>
                <FieldRow
                  className="col-span-2"
                  label="透传 Header (每行 key: value)"
                  hint="如 anthropic-beta: context-1m-2025-08-07"
                >
                  <textarea
                    className={cn(
                      'w-full min-h-[60px] rounded border border-input bg-background px-2 py-1 text-sm font-mono',
                      borderClassForIssues(headerIssues),
                    )}
                    value={tier.extra_headers_text}
                    onChange={(e) => updateAt(idx, { extra_headers_text: e.target.value })}
                    placeholder="anthropic-beta: context-1m-2025-08-07"
                    aria-invalid={headerIssues.some((i) => i.level === 'error') || undefined}
                  />
                </FieldRow>

                <div className="col-span-2 mt-1 pt-2 border-t border-border/60">
                  <div className="text-xs font-medium text-muted-foreground mb-2">
                    精确阶梯计费（可选）— 表达「≤ 阈值标准价、超出部分加价」语义，对齐 ZenMux 1M 计价
                  </div>
                </div>
                <FieldRow label="阈值 (Token)" hint="如 200000：超出此值按 over_* 单价">
                  <Input
                    type="number"
                    className={borderClassForIssues(aboveIssues) ?? undefined}
                    value={tier.applies_above_tokens}
                    onChange={(e) => updateAt(idx, { applies_above_tokens: e.target.value })}
                    aria-invalid={aboveIssues.some((i) => i.level === 'error') || undefined}
                  />
                </FieldRow>
                <FieldRow label="超阈值后输入单价" hint="如标准价 × 2">
                  <Input
                    type="number"
                    step="0.000001"
                    className={borderClassForIssues(overIssues) ?? undefined}
                    value={tier.over_input_price_per_1k}
                    onChange={(e) => updateAt(idx, { over_input_price_per_1k: e.target.value })}
                  />
                </FieldRow>
                <FieldRow label="超阈值后输出单价" hint="如标准价 × 1.5">
                  <Input
                    type="number"
                    step="0.000001"
                    className={borderClassForIssues(overIssues) ?? undefined}
                    value={tier.over_output_price_per_1k}
                    onChange={(e) => updateAt(idx, { over_output_price_per_1k: e.target.value })}
                  />
                </FieldRow>
              </div>
            )}

            {/* 行末问题列表：列出该档所有错误/警告。
                折叠态也显示，避免运营被红边吓到却找不到原因。 */}
            {rowIssues.length > 0 && (
              <div className="space-y-0.5 pl-7">
                {rowIssues.map((issue, i) => (
                  <IssueLine key={`r-${idx}-${i}`} issue={issue} />
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function IssueLine({ issue }: { issue: TierIssue }) {
  const Icon = issue.level === 'error' ? AlertTriangle : Info
  return (
    <div
      className={cn(
        'flex items-start gap-1.5 text-[11px]',
        issue.level === 'error' ? 'text-destructive' : 'text-warning',
      )}
    >
      <Icon className="h-3 w-3 mt-0.5 flex-shrink-0" />
      <span>{issue.message}</span>
    </div>
  )
}

function FieldRow({
  label,
  hint,
  children,
  className,
}: {
  label: string
  hint?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <div className="text-xs font-medium mb-0.5">{label}</div>
      {children}
      {hint && <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  )
}
