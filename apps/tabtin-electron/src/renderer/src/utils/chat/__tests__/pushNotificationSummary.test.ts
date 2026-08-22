/**
 * pushNotificationSummary 单测 —— A 展示层：P2-1（兜底走 i18n）+ P2-5（三态文案 / tone）。
 *
 * 直接构造 ParsedPushNotification（聚焦展示层，不重测 parse），用可控的 mock t 断言：
 *   - P2-1：exit-code / status 兜底**走 i18n key**（而非硬编码中文）——用 spy t 记录被查 key；
 *   - P2-5：success / stopped（用户主动停止，中性）/ failed（异常）三态文案与 tone 正确。
 */

import { describe, it, expect } from 'vitest'
import { buildPushSummary, pickPushSummaryTone } from '@utils/chat/pushNotificationSummary'
import type { ParsedPushNotification, ParsedPushTask } from '@utils/chat/pushNotificationParse'

type Translate = (key: string, options?: Record<string, unknown>) => string

/** 返回 defaultValue（模拟 i18n 未加载 / zh 兜底）。 */
const tDefault: Translate = (key, opts) => (opts?.defaultValue as string) ?? key

function shellTask(outcome: ParsedPushTask['outcome'], extra: Partial<ParsedPushTask> = {}): ParsedPushTask {
  return { kind: 'shell', title: 'do-thing', outcome, ...extra }
}
function subagentTask(outcome: ParsedPushTask['outcome'], extra: Partial<ParsedPushTask> = {}): ParsedPushTask {
  return { kind: 'subagent', title: '测试助手', outcome, ...extra }
}
function makeParsed(tasks: ParsedPushTask[]): ParsedPushNotification {
  return {
    tasks,
    shellCount: tasks.filter((t) => t.kind === 'shell').length,
    subagentCount: tasks.filter((t) => t.kind === 'subagent').length,
    failedCount: tasks.filter((t) => t.outcome === 'failed').length,
  }
}

describe('buildPushSummary — 优先展示 description（命令意图摘要）', () => {
  it('shell success 带 description：摘要用 description 而非裸命令', () => {
    const text = buildPushSummary(
      makeParsed([shellTask('success', { title: 'sleep 7 && echo done', description: '后台计时5秒' })]),
      tDefault,
    )
    expect(text).toContain('后台计时5秒')
    expect(text).not.toContain('sleep 7')
  })

  it('shell success 无 description：回落裸命令', () => {
    const text = buildPushSummary(
      makeParsed([shellTask('success', { title: 'sleep 7 && echo done' })]),
      tDefault,
    )
    expect(text).toContain('sleep 7 && echo done')
  })
})

describe('buildPushSummary — P2-1 兜底走 i18n（无硬编码中文）', () => {
  it('shell failed 缺退出码：通过 i18n key pushNotification.unknownFailureReason 取兜底（非硬编码原因）', () => {
    const keys: string[] = []
    const tSpy: Translate = (key, opts) => {
      keys.push(key)
      return (opts?.defaultValue as string) ?? key
    }
    buildPushSummary(makeParsed([shellTask('failed', { exitCode: undefined })]), tSpy)
    expect(keys).toContain('pushNotification.unknownFailureReason')
  })

  it('subagent failed：status 短词通过 i18n key pushNotification.subagentStatus.* 取（非硬编码中文 map）', () => {
    const keys: string[] = []
    const tSpy: Translate = (key, opts) => {
      keys.push(key)
      return (opts?.defaultValue as string) ?? key
    }
    buildPushSummary(makeParsed([subagentTask('failed', { status: 'failed' })]), tSpy)
    expect(keys).toContain('pushNotification.subagentStatus.failed')
  })

  it('模拟 en locale：失败摘要全英文、无中文残留（中英不混杂）', () => {
    const EN: Record<string, string> = {
      'pushNotification.unknownFailureReason': 'unknown reason',
      'pushNotification.shellFailed': 'Background command failed: cmd (unknown reason)',
    }
    const tEn: Translate = (key, opts) => EN[key] ?? (opts?.defaultValue as string) ?? key
    const text = buildPushSummary(makeParsed([shellTask('failed', { exitCode: undefined })]), tEn)
    expect(text).toContain('unknown')
    expect(/[\u4e00-\u9fff]/.test(text)).toBe(false)
  })
})

describe('buildPushSummary — P2-5 三态文案', () => {
  it('shell success → 完成', () => {
    const text = buildPushSummary(makeParsed([shellTask('success', { exitCode: 0 })]), tDefault)
    expect(text).toContain('完成')
    expect(text).not.toContain('退出码 0')
  })
  it('shell stopped（用户主动停止）→ 已停止（中性，不出现"失败/终止"）', () => {
    const text = buildPushSummary(makeParsed([shellTask('stopped', { killedReason: 'user_interrupt' })]), tDefault)
    expect(text).toContain('已停止')
    expect(text).not.toContain('失败')
    expect(text).not.toContain('已终止')
  })
  it('shell failed（hard_timeout 被杀）→ 已终止（异常）', () => {
    const text = buildPushSummary(makeParsed([shellTask('failed', { killedReason: 'hard_timeout' })]), tDefault)
    expect(text).toContain('已终止')
  })
  it('shell failed（非零退出）→ 失败 + 用户可读原因', () => {
    const text = buildPushSummary(makeParsed([shellTask('failed', { exitCode: 2 })]), tDefault)
    expect(text).toContain('失败')
    expect(text).toContain('命令执行失败')
    expect(text).not.toContain('退出码 2')
  })
  it('shell failed（命令不存在）→ 显示找不到命令', () => {
    const text = buildPushSummary(makeParsed([shellTask('failed', { exitCode: 127 })]), tDefault)
    expect(text).toContain('找不到命令')
    expect(text).not.toContain('退出码 127')
  })
  it('subagent stopped（cancelled）→ 已停止（中性）', () => {
    const text = buildPushSummary(makeParsed([subagentTask('stopped', { status: 'cancelled' })]), tDefault)
    expect(text).toContain('已停止')
  })
  it('多任务含异常 → 计异常数', () => {
    const text = buildPushSummary(
      makeParsed([shellTask('success', { exitCode: 0 }), shellTask('failed', { exitCode: 1 })]),
      tDefault,
    )
    expect(text).toContain('异常')
  })
})

describe('pickPushSummaryTone — P2-5 三态视觉（中性 vs 红 vs 绿）', () => {
  it('单任务 success → success（绿）', () => {
    expect(pickPushSummaryTone(makeParsed([shellTask('success', { exitCode: 0 })]))).toBe('success')
  })
  it('单任务 stopped（用户主动）→ neutral（中性灰，不报红）', () => {
    expect(pickPushSummaryTone(makeParsed([shellTask('stopped', { killedReason: 'kill_tool' })]))).toBe('neutral')
    expect(pickPushSummaryTone(makeParsed([subagentTask('stopped', { status: 'cancelled' })]))).toBe('neutral')
  })
  it('单任务 failed（超时/异常）→ failure（红）', () => {
    expect(pickPushSummaryTone(makeParsed([shellTask('failed', { killedReason: 'hard_timeout' })]))).toBe('failure')
  })
  it('多任务有异常 → failure', () => {
    expect(pickPushSummaryTone(makeParsed([shellTask('success', { exitCode: 0 }), shellTask('failed', { exitCode: 1 })]))).toBe('failure')
  })
  it('多任务无异常（含 stopped）→ success（不因中性停止报红）', () => {
    expect(
      pickPushSummaryTone(makeParsed([shellTask('success', { exitCode: 0 }), shellTask('stopped', { killedReason: 'user_interrupt' })])),
    ).toBe('success')
  })
})
