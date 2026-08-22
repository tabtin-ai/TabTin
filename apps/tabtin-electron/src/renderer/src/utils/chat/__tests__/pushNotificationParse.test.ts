/**
 * pushNotificationParse 单测 —— 覆盖 A「系统通知收敛」的 XML 解析。
 *
 * content 字符串精确复刻 `packages/terminal-core/src/notification-prompt.ts`
 * 的合成格式（手写而非跨包 import，避免把 Node-only 依赖拉进 renderer 测试环境）：
 *   - shell：prefix + `<task-notification>`（无 kind）+ 尾句；
 *   - subagent：prefix + `<task-notification kind="subagent-completed">` + 尾句；
 *   - 混合：shell 段在前、subagent 段在后，空行分隔。
 */

import { describe, it, expect } from 'vitest'
import { parsePushNotification } from '@utils/chat/pushNotificationParse'

const SHELL_PREFIX_1 = 'A background command completed while you were doing other work:'
const SHELL_TAIL = 'Read the output-file path if you need to see the full output.'
const SUBAGENT_PREFIX_1 = 'A background sub-agent finished while you were doing other work:'
const SUBAGENT_TAIL =
  "The sub-agent's result summary is above. Resume it with its subagent-run-id if you want it to continue, or read the summary-file path for the full output if present."

function shellBlock(opts: {
  command: string
  exitCode: number | string
  exitedBy?: string
  killedReason?: string
  description?: string
}): string {
  const lines = [
    '<task-notification>',
    '<agent-session-id>sess-1</agent-session-id>',
    ...(opts.description ? [`<description>${opts.description}</description>`] : []),
    `<command>${opts.command}</command>`,
    `<exit-code>${opts.exitCode}</exit-code>`,
    `<exited-by>${opts.exitedBy ?? 'normal_exit'}</exited-by>`,
  ]
  if (opts.killedReason) lines.push(`<killed-reason>${opts.killedReason}</killed-reason>`)
  lines.push('<duration-ms>1000</duration-ms>', '<output-file>/tmp/x.log</output-file>', '<cwd>/home</cwd>', '</task-notification>')
  return lines.join('\n')
}

function subagentBlock(opts: { label: string; status: string; summary?: string; parentToolCallId?: string }): string {
  const lines = [
    '<task-notification kind="subagent-completed">',
    '<subagent-run-id>run-1</subagent-run-id>',
    `<label>${opts.label}</label>`,
    `<status>${opts.status}</status>`,
    '<duration-ms>2000</duration-ms>',
  ]
  if (opts.parentToolCallId) {
    lines.push(`<parent-tool-call-id>${opts.parentToolCallId}</parent-tool-call-id>`)
  }
  lines.push(`<summary>${opts.summary ?? '已完成'}</summary>`, '</task-notification>')
  return lines.join('\n')
}

function shellContent(blocks: string[]): string {
  const prefix =
    blocks.length === 1
      ? SHELL_PREFIX_1
      : `${blocks.length} background commands completed while you were doing other work:`
  return `${prefix}\n\n${blocks.join('\n\n')}\n\n${SHELL_TAIL}`
}

function subagentContent(blocks: string[]): string {
  const prefix =
    blocks.length === 1
      ? SUBAGENT_PREFIX_1
      : `${blocks.length} background sub-agents finished while you were doing other work:`
  return `${prefix}\n\n${blocks.join('\n\n')}\n\n${SUBAGENT_TAIL}`
}

describe('parsePushNotification — shell', () => {
  it('带 <description> 时解析出 task.description（命令意图摘要）', () => {
    const content = shellContent([shellBlock({ command: 'sleep 7 && echo done', exitCode: 0, description: '后台计时5秒' })])
    const parsed = parsePushNotification(content)
    expect(parsed?.tasks[0]).toMatchObject({ kind: 'shell', title: 'sleep 7 && echo done', description: '后台计时5秒' })
  })

  it('无 <description> 时 task.description 为 undefined（不影响其余字段）', () => {
    const content = shellContent([shellBlock({ command: 'ls -la', exitCode: 0 })])
    const parsed = parsePushNotification(content)
    expect(parsed?.tasks[0].description).toBeUndefined()
  })

  it('单条成功命令：outcome=success、exitCode=0、计数正确', () => {
    const content = shellContent([shellBlock({ command: 'ls -la', exitCode: 0 })])
    const parsed = parsePushNotification(content)
    expect(parsed).not.toBeNull()
    expect(parsed!.tasks).toHaveLength(1)
    expect(parsed!.shellCount).toBe(1)
    expect(parsed!.subagentCount).toBe(0)
    expect(parsed!.failedCount).toBe(0)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', title: 'ls -la', outcome: 'success', exitCode: 0 })
  })

  it('非零退出码 + normal_exit（npm test 用例失败 / grep 无匹配）→ outcome=success（不再凭退出码误判失败）', () => {
    // 核心修复：退出码非零本身不算失败，以执行层 exited_by 为准；normal_exit = 正常完成。
    const content = shellContent([shellBlock({ command: 'npm test', exitCode: 1, exitedBy: 'normal_exit' })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', outcome: 'success', exitCode: 1 })
    expect(parsed!.failedCount).toBe(0)
  })

  it('exec_failure（命令起不来 126/127）→ outcome=failed、failedCount=1', () => {
    const content = shellContent([shellBlock({ command: 'missing-bin', exitCode: 127, exitedBy: 'exec_failure' })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', outcome: 'failed', exitCode: 127 })
    expect(parsed!.failedCount).toBe(1)
  })

  it('超时被杀（hard_timeout）：outcome=failed（异常）、携带 killedReason', () => {
    const content = shellContent([
      shellBlock({ command: 'sleep 999', exitCode: 0, exitedBy: 'signal', killedReason: 'hard_timeout' }),
    ])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', outcome: 'failed', killedReason: 'hard_timeout' })
    expect(parsed!.failedCount).toBe(1)
  })

  it("exit-code 为 'null'：exitCode=undefined、outcome=failed", () => {
    const content = shellContent([shellBlock({ command: 'crashed', exitCode: 'null', exitedBy: 'exec_failure' })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0].exitCode).toBeUndefined()
    expect(parsed!.tasks[0].outcome).toBe('failed')
  })

  it('多条命令：shellCount=2、tasks 顺序保持', () => {
    const content = shellContent([
      shellBlock({ command: 'cmd-a', exitCode: 0 }),
      shellBlock({ command: 'cmd-b', exitCode: 127, exitedBy: 'exec_failure' }),
    ])
    const parsed = parsePushNotification(content)
    expect(parsed!.shellCount).toBe(2)
    expect(parsed!.tasks.map((t) => t.title)).toEqual(['cmd-a', 'cmd-b'])
    expect(parsed!.failedCount).toBe(1)
  })

  it('XML 转义还原：& < > 等被正确解码', () => {
    const escaped = 'echo &quot;a&quot; &amp;&amp; b &lt;c&gt;'
    const content = shellContent([shellBlock({ command: escaped, exitCode: 0 })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0].title).toBe('echo "a" && b <c>')
  })
})

describe('parsePushNotification — subagent', () => {
  it('兼容旧历史中的 kind 空格写法和缺 status 子 Agent 通知', () => {
    const content = [
      SUBAGENT_PREFIX_1,
      '',
      '<task-notification kind = "subagent-completed">',
      '<subagent-run-id>run-legacy</subagent-run-id>',
      '<label>后台子 Agent</label>',
      '</task-notification>',
      '',
      SUBAGENT_TAIL,
    ].join('\n')
    const parsed = parsePushNotification(content)
    expect(parsed).not.toBeNull()
    expect(parsed!.tasks[0]).toMatchObject({
      kind: 'subagent',
      title: '后台子 Agent',
      subagentRunId: 'run-legacy',
      outcome: 'failed',
    })
    expect(parsed!.subagentCount).toBe(1)
  })

  it('completed：outcome=success、subagentCount=1', () => {
    const content = subagentContent([subagentBlock({ label: '测试助手', status: 'completed' })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({
      kind: 'subagent',
      title: '测试助手',
      outcome: 'success',
      status: 'completed',
      subagentRunId: 'run-1',
    })
    expect(parsed!.subagentCount).toBe(1)
    expect(parsed!.failedCount).toBe(0)
  })

  it('解析 parent-tool-call-id，供 UI 把完成通知锚定回 assistant 时间轴', () => {
    const content = subagentContent([
      subagentBlock({ label: '查看磁盘使用情况', status: 'completed', parentToolCallId: 'toolu-df' }),
    ])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({
      kind: 'subagent',
      subagentRunId: 'run-1',
      parentToolCallId: 'toolu-df',
    })
  })

  it.each(['failed', 'timeout'])('异常终态 %s：outcome=failed、failedCount=1', (status) => {
    const content = subagentContent([subagentBlock({ label: '科普撰稿人', status })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'subagent', outcome: 'failed', status })
    expect(parsed!.failedCount).toBe(1)
  })

  it('用户主动取消 cancelled：outcome=stopped（中性、不计异常）', () => {
    const content = subagentContent([subagentBlock({ label: '科普撰稿人', status: 'cancelled' })])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'subagent', outcome: 'stopped', status: 'cancelled' })
    expect(parsed!.failedCount).toBe(0)
  })
})

describe('parsePushNotification — 混合 & 回落', () => {
  it('shell + subagent 混合段：两类都正确归类', () => {
    const content = `${shellContent([shellBlock({ command: 'build', exitCode: 0 })])}\n\n${subagentContent([
      subagentBlock({ label: '助手', status: 'failed' }),
    ])}`
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks).toHaveLength(2)
    expect(parsed!.shellCount).toBe(1)
    expect(parsed!.subagentCount).toBe(1)
    expect(parsed!.failedCount).toBe(1)
    expect(parsed!.tasks[0].kind).toBe('shell')
    expect(parsed!.tasks[1].kind).toBe('subagent')
  })

  it('无 task-notification 块 → 返回 null（回落 raw）', () => {
    expect(parsePushNotification('这是一条普通系统提示，没有任何结构化任务。')).toBeNull()
  })

  it('空 / null / undefined 输入 → null', () => {
    expect(parsePushNotification('')).toBeNull()
    expect(parsePushNotification(null)).toBeNull()
    expect(parsePushNotification(undefined)).toBeNull()
  })

  it('缺 prefix 但含 task-notification 仍能解析（鲁棒，不依赖文案）', () => {
    const bare = shellBlock({ command: 'bare', exitCode: 0 })
    const parsed = parsePushNotification(bare)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', title: 'bare', outcome: 'success' })
  })
})

describe('parsePushNotification — P2-5 三态（用户主动停止 vs 异常）', () => {
  it.each(['kill_tool', 'user_interrupt'])('shell 主动终止 %s → outcome=stopped、不计异常', (killedReason) => {
    const content = shellContent([
      shellBlock({ command: 'long-task', exitCode: 0, exitedBy: 'signal', killedReason }),
    ])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', outcome: 'stopped', killedReason })
    expect(parsed!.failedCount).toBe(0)
  })

  it.each(['hard_timeout', 'app_exit'])('shell 非预期终止 %s → outcome=failed（异常红）', (killedReason) => {
    const content = shellContent([
      shellBlock({ command: 'long-task', exitCode: 0, exitedBy: 'signal', killedReason }),
    ])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks[0]).toMatchObject({ kind: 'shell', outcome: 'failed', killedReason })
    expect(parsed!.failedCount).toBe(1)
  })

  it('多任务混合：stopped 不计入 failedCount，仅 failed 计入', () => {
    const content = shellContent([
      shellBlock({ command: 'ok', exitCode: 0 }),
      shellBlock({ command: 'stopped', exitCode: 0, exitedBy: 'signal', killedReason: 'user_interrupt' }),
      shellBlock({ command: 'bad', exitCode: 127, exitedBy: 'exec_failure' }),
    ])
    const parsed = parsePushNotification(content)
    expect(parsed!.tasks.map((t) => t.outcome)).toEqual(['success', 'stopped', 'failed'])
    expect(parsed!.failedCount).toBe(1)
  })
})
