/**
 * approvalDetailFormat 单测——覆盖 packages/browser-core browser-policy.ts 实际产出的
 * detail 格式（真实样例见该文件 evaluateBrowserActionPolicyInternal / evaluateBatch /
 * evaluateAct / evaluateDownloadGuardrail）。
 */

import { describe, expect, it } from 'vitest'
import {
  formatApprovalDetailLines,
  getApprovalActionLabel,
  parseApprovalDetail,
} from './approvalDetailFormat'

/** 模拟 i18next：dict 命中则用 dict 译文，否则回落 defaultValue（同真实 i18next 语义）。 */
function fakeT(dict: Record<string, string> = {}) {
  return (key: string, opts?: Record<string, unknown>): string => {
    if (key in dict) return dict[key]!
    const defaultValue = opts?.defaultValue
    return typeof defaultValue === 'string' ? defaultValue : key
  }
}

describe('parseApprovalDetail', () => {
  it('解析简单 key=value：actionId=open risk=write', () => {
    expect(parseApprovalDetail('actionId=open risk=write')).toEqual([
      { key: 'actionId', value: 'open' },
      { key: 'risk', value: 'write' },
    ])
  })

  it('解析 batch 带括号 childActions 列表', () => {
    expect(
      parseApprovalDetail(
        'actionId=batch risk=high-risk-write childActions=[act, cookies.clear]',
      ),
    ).toEqual([
      { key: 'actionId', value: 'batch' },
      { key: 'risk', value: 'high-risk-write' },
      { key: 'childActions', value: 'act, cookies.clear' },
    ])
  })

  it('解析 act: click, type 这种 prefix: rest 格式', () => {
    expect(parseApprovalDetail('act: click, type')).toEqual([
      { key: 'act', value: 'click, type' },
    ])
  })

  it('解析 act 无 actions 时的占位 rest', () => {
    expect(parseApprovalDetail('act: <空 actions>')).toEqual([
      { key: 'act', value: '<空 actions>' },
    ])
  })

  it('解析 download guardrail + suggestAsync', () => {
    expect(
      parseApprovalDetail(
        'actionId=resource.download risk=read guardrail=[signed-url, cross-origin] suggestAsync=true',
      ),
    ).toEqual([
      { key: 'actionId', value: 'resource.download' },
      { key: 'risk', value: 'read' },
      { key: 'guardrail', value: 'signed-url, cross-origin' },
      { key: 'suggestAsync', value: 'true' },
    ])
  })

  it('未知/非结构化 detail 原样兜底为单条 raw', () => {
    const detail = 'rm -rf /tmp/test'
    expect(parseApprovalDetail(detail)).toEqual([{ key: 'raw', value: detail }])
  })

  it('key=value 片段无法覆盖全文时兜底 raw（避免误判半结构化文本）', () => {
    const detail = 'download file from https://example.com then actionId=open risk=write extra text'
    expect(parseApprovalDetail(detail)).toEqual([{ key: 'raw', value: detail }])
  })

  it('空字符串兜底为 raw', () => {
    expect(parseApprovalDetail('')).toEqual([{ key: 'raw', value: '' }])
  })
})

describe('formatApprovalDetailLines', () => {
  it('翻译简单 actionId/risk 组合', () => {
    const t = fakeT({
      'approval.detailKeys.actionId': '操作',
      'approval.detailKeys.risk': '风险',
      'approval.browserActions.open': '打开页面',
      'approval.risks.write': '写入',
    })
    expect(formatApprovalDetailLines('actionId=open risk=write', t)).toEqual([
      '操作：打开页面',
      '风险：写入',
    ])
  })

  it('翻译 batch childActions 列表为中文动作名，逐项用「、」拼接', () => {
    const t = fakeT({
      'approval.detailKeys.actionId': '操作',
      'approval.detailKeys.risk': '风险',
      'approval.detailKeys.childActions': '子操作',
      'approval.browserActions.batch': '批量操作',
      'approval.risks.high-risk-write': '高风险写入',
      'approval.browserActions.act': '页面交互',
      'approval.browserActions.cookies.clear': '清除 Cookie',
    })
    expect(
      formatApprovalDetailLines(
        'actionId=batch risk=high-risk-write childActions=[act, cookies.clear]',
        t,
      ),
    ).toEqual(['操作：批量操作', '风险：高风险写入', '子操作：页面交互、清除 Cookie'])
  })

  it('翻译 download guardrail 信号列表 + suggestAsync 布尔值', () => {
    const t = fakeT({
      'approval.browserActions.resource.download': '下载资源',
      'approval.risks.read': '只读',
      'approval.guardrailSignals.signed-url': '临时签名链接',
      'approval.guardrailSignals.cross-origin': '跨站',
      'approval.detailValues.yes': '是',
    })
    expect(
      formatApprovalDetailLines(
        'actionId=resource.download risk=read guardrail=[signed-url, cross-origin] suggestAsync=true',
        t,
      ),
    ).toEqual([
      '操作：下载资源',
      '风险：只读',
      '护栏信号：临时签名链接、跨站',
      '建议异步执行：是',
    ])
  })

  it('未命中翻译的字段名 / 值均回落中文兜底或原文，不报错', () => {
    const t = fakeT()
    expect(formatApprovalDetailLines('actionId=unknown.action risk=write', t)).toEqual([
      '操作：unknown.action',
      '风险：write',
    ])
  })

  it('未知护栏信号保留原文', () => {
    const t = fakeT({ 'approval.guardrailSignals.signed-url': '临时签名链接' })
    expect(
      formatApprovalDetailLines(
        'actionId=resource.download risk=read guardrail=[signed-url, some-new-signal]',
        t,
      ),
    ).toEqual(['操作：resource.download', '风险：read', '护栏信号：临时签名链接、some-new-signal'])
  })

  it('非结构化 detail 兜底整行展示原文', () => {
    const t = fakeT({ 'approval.detailKeys.raw': '原始参数' })
    expect(formatApprovalDetailLines('rm -rf /tmp/test', t)).toEqual([
      '原始参数：rm -rf /tmp/test',
    ])
  })
})

describe('getApprovalActionLabel', () => {
  it('直接命中 approval.actions.<type>（既有非 browser 动作，如终端命令）', () => {
    const t = fakeT({ 'approval.actions.execute_in_terminal': '在终端中执行命令' })
    expect(getApprovalActionLabel('execute_in_terminal', t)).toBe('在终端中执行命令')
  })

  it('browser.xxx 无直接 key 时回落 approval.browserActions.xxx', () => {
    const t = fakeT({ 'approval.browserActions.open': '打开页面' })
    expect(getApprovalActionLabel('browser.open', t)).toBe('打开页面')
  })

  it('browser.xxx 若已有直接 key 则优先直接 key，不查 browserActions', () => {
    const t = fakeT({
      'approval.actions.browser.open': '直接命中的翻译',
      'approval.browserActions.open': '打开页面',
    })
    expect(getApprovalActionLabel('browser.open', t)).toBe('直接命中的翻译')
  })

  it('未知 actionType 且无任何翻译时回落 actionType 本身', () => {
    const t = fakeT()
    expect(getApprovalActionLabel('totally_unknown_action', t)).toBe('totally_unknown_action')
  })
})
