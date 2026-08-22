/**
 * ApprovalPanel 渲染回归测试 — 覆盖 W4 dogfood 期 formatToolArgs 崩栈修复 +
 * v0.4 W1.5 batch 形态新增字段（runtime_mode / decision_reason / rejection_message）。
 *
 * 业务背景：
 *   用户问"介绍一下 tabtin"触发 web_search 审批，后端 emit 了 review_required（v0.4
 *   后是 approval_requested batch 形态），但只有 `command` 字段（undefined）。前端
 *   sendMessageAction 把 `arguments: { command: undefined }` 喂给
 *   ApprovalPanel.formatToolArgs，`JSON.stringify(undefined) === undefined`（不是字符串！），
 *   紧接的 `val.length` 抛 `Cannot read properties of undefined`，整个审批 UI 挂掉。
 *
 * 三层修复后，本测试守住前端最后一道：
 *   1. `arguments: { command: undefined }` 渲染时不崩（崩则整个组件 throw）。
 *   2. `arguments: { search_term, explanation }` 正常被人类可读地展示。
 *   3. `arguments` 为空 / 全 undefined 时不显示 args 部分（不出现"undefined"字样）。
 */

import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { UNKNOWN_WORKSPACE_OUT_PATH } from '@tabtin/security-policy/approval-contract'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  toast: vi.fn(),
}))

const { appendSessionAllowedPathMock } = vi.hoisted(() => ({
  appendSessionAllowedPathMock: vi.fn(),
}))

const { scrollToToolCallMock } = vi.hoisted(() => ({
  scrollToToolCallMock: vi.fn(),
}))

vi.mock('../../tool/scrollToToolCall', () => ({
  scrollToToolCall: scrollToToolCallMock,
}))

// 升档按钮走独立组件（依赖 org / auth / space 等一串 store），Panel 测试里
// stub 成透传 onUpgraded 的按钮：可点击即视为「升档成功 → 放行本批」。
vi.mock('../ApprovalTierUpgradeButton', () => ({
  ApprovalTierUpgradeButton: ({ onUpgraded, disabled }: { onUpgraded: () => void; disabled?: boolean }) => (
    <button
      type="button"
      data-testid="approval-tier-upgrade"
      className="whitespace-nowrap shrink-0"
      disabled={disabled}
      onClick={onUpgraded}
    >
      upgrade-stub
    </button>
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { selectedSpace: { id: string } }) => unknown) =>
    selector({ selectedSpace: { id: 'space-1' } }),
}))

// 单根契约 §2.4：审批通过的路径通过 window.tabtin.workspace.appendSessionAllowedPath
// IPC 推到 main 端 session.workspaceSnapshot.sources.sessionApprovedPaths（不写 store）。
;(globalThis as unknown as { window: { tabtin: { workspace: { appendSessionAllowedPath: typeof appendSessionAllowedPathMock } } } }).window = {
  tabtin: {
    workspace: { appendSessionAllowedPath: appendSessionAllowedPathMock },
  },
}

describe('ApprovalPanel · formatToolArgs 崩栈防御 + web_search 渲染回归', () => {
  it('arguments: { command: undefined } 不崩（W4 dogfood 实际 payload 形状）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    expect(() =>
      render(
        <ApprovalPanel
          actionRequests={[{
            tool_name: 'web_search',
            arguments: { command: undefined },
          }]}
          onSubmit={vi.fn()}
        />,
      ),
    ).not.toThrow()

    // web_search 不再走富内容呈现卡片，回到标准 WebSearchCard 工具标签。
    expect(screen.getByText('card.web_search')).toBeTruthy()
    expect(screen.queryByText('web_search')).toBeNull()
    expect(screen.queryByText(/undefined/)).toBeNull()
  })

  it('web_search 完整 args（search_term + explanation）在卡片上人类可读地展示', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'web_search',
          arguments: {
            search_term: 'tabtin',
            explanation: '用户想了解 tabtin 是什么',
          },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('card.web_search')).toBeTruthy()
    expect(screen.queryByText('web_search')).toBeNull()
    // 可读性重排：search_term 是 canonical query 字段，按「查询」标签 + 值
    // 分行结构化展示（stub i18n 下标签显示 key 原文），不再拼 "search_term: xxx"。
    expect(screen.getByText('approval.field.query')).toBeTruthy()
    expect(screen.getByText('tabtin')).toBeTruthy()
    // ApprovalPanel 把 `explanation` 字段单独渲染成纯文本（不带 "explanation:" 前缀）。
    // 原断言 `/explanation:/` 与当前 UI 不符；改为断言 explanation 原文出现。
    expect(screen.getByText(/用户想了解 tabtin 是什么/)).toBeTruthy()
  })

  it('全 undefined 的 arguments 不显示 args 段、不崩', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'noop_tool',
          arguments: { command: undefined, cwd: undefined },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByText('noop_tool')).toBeNull()
    expect(screen.queryByText(/undefined/)).toBeNull()
    expect(screen.queryByText(/:\s*,/)).toBeNull()
  })

  it('混合 args（部分 undefined + 部分有值）只展示有值字段', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'mcp_tool',
          arguments: { command: undefined, query: 'hello world', flag: undefined },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByText('mcp_tool')).toBeNull()
    // query 是 canonical 字段 → 结构化「查询」行；undefined 的 command/flag 不出现
    expect(screen.getByText('approval.field.query')).toBeTruthy()
    expect(screen.getByText('hello world')).toBeTruthy()
    expect(screen.queryByText('approval.field.command')).toBeNull()
    expect(screen.queryByText(/flag:/)).toBeNull()
  })

  it('回归：run_terminal_command 的 { command: "echo hi" } 仍能渲染', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('card.terminal')).toBeTruthy()
    expect(screen.queryByText('run_terminal_command')).toBeNull()
    // 可读性重排：command 按「命令」标签 + 值分行结构化展示
    expect(screen.getByText('approval.field.command')).toBeTruthy()
    expect(screen.getByText('echo hi')).toBeTruthy()
  })
})

describe('ApprovalPanel · 外部决策详情态', () => {
  it('只展示操作内容，不重复渲染允许/拒绝或响应审批快捷键', async () => {
    const onSubmit = vi.fn()
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-1',
          tool_call_id: 'call-1',
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hello' },
        }]}
        onSubmit={onSubmit}
        decisionSurface="external"
      />,
    )

    expect(screen.getByTestId('approval-external-decision-hint')).toBeTruthy()
    expect(screen.queryByTestId('approval-panel-footer')).toBeNull()
    expect(screen.queryByTestId('approval-allow')).toBeNull()

    fireEvent.keyDown(document, { key: 'Enter', metaKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

/**
 * 浏览器动作平台审批：description 是 browser-policy 生成的机读 key=value 串
 * （如 `actionId=open risk=write`）。历史上 ApprovalPanel 把它原样渲染，露出英文；
 * 现复用统一的 approvalDetailFormat 汉化成中文行。
 * 取证：图片显示卡片直接展示 "actionId=open risk=write"。
 */
describe('ApprovalPanel · 浏览器动作 detail 汉化（复用 approvalDetailFormat）', () => {
  it('browser.* 审批的 actionId=open risk=write 被格式化成多行，不再裸奔原串', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'browser.open',
          description: 'actionId=open risk=write',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    // 机读原串整段不再作为唯一展示出现
    expect(screen.queryByText('actionId=open risk=write')).toBeNull()
    expect(screen.queryByText(/actionId=open/)).toBeNull()
    // 逐字段汉化行（stub i18n 下标签/值显示 key 原文，真机 i18n 下为「操作：打开浏览器页面」等）
    expect(screen.getByText('approval.detailKeys.actionId：approval.browserActions.open')).toBeTruthy()
    expect(screen.getByText('approval.detailKeys.risk：approval.risks.write')).toBeTruthy()
  })

  it('非结构化 description（如裸命令）回落原文，不误加字段前缀', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'browser.act',
          description: 'rm -rf /tmp/test',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('rm -rf /tmp/test')).toBeTruthy()
  })

  it('非 browser.* 工具的 description 不进 detail 汉化（保持既有兜底渲染）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'some_tool',
          description: 'actionId=open risk=write',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    // 非 browser 工具不触发 detail 汉化，description 原样兜底
    expect(screen.getByText('actionId=open risk=write')).toBeTruthy()
  })

  it('detail 汉化所需 sandbox i18n key 在 zh-CN / en-US 均已配置', async () => {
    const zh = (await import('../../../../i18n/locales/zh-CN/sandbox.json')).default as {
      approval: {
        detailKeys: Record<string, string>
        browserActions: Record<string, string>
        risks: Record<string, string>
      }
    }
    const en = (await import('../../../../i18n/locales/en-US/sandbox.json')).default as typeof zh

    for (const dict of [zh, en]) {
      expect(dict.approval.detailKeys.actionId).toBeTruthy()
      expect(dict.approval.detailKeys.risk).toBeTruthy()
      expect(dict.approval.browserActions.open).toBeTruthy()
      expect(dict.approval.risks.write).toBeTruthy()
    }
  })
})

/**
 * 审批卡片可读性重排：结构化参数分行、长路径中间省略、长文本折叠。
 *
 * 历史问题：后端 extractOperationSummary 把完整参数（temp 落盘路径 + 大段
 * question）拼成一个 description，前端再和工具名挤在同一行 font-mono——
 * grep_search 这类带路径和长查询的工具审批卡片沦为一大坨不可读文本（小红书 dogfood 截图取证）。
 */
describe('ApprovalPanel · 可读性重排（结构化参数 / 路径省略 / 长文本折叠）', () => {
  const LONG_TMP_PATH = '/private/var/folders/0m/rfynb_0d1rz5z6wznlwn41q8000gn/T/tabtin-tool-results/43217863-491a-458b-8790-6146cf806c44/shell-run_terminal_command_4-stdout.log'

  it('grep_search 场景：path + query 分行结构化展示，不再使用后端拼接的 description', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const query = '这个 snapshot 是小红书首页，请帮我找出搜索框的元素 ref 和 selector'

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'grep_search',
          description: `路径：${LONG_TMP_PATH}\n查询：${query}`,
          arguments: { path: LONG_TMP_PATH, query },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    // 结构化字段行（stub i18n 下标签显示 key 原文）
    expect(screen.getByText('approval.field.path')).toBeTruthy()
    expect(screen.getByText('approval.field.query')).toBeTruthy()
    expect(screen.getByText(query)).toBeTruthy()
    // 后端拼好的 description 整段不再出现
    expect(screen.queryByText(`路径：${LONG_TMP_PATH}\n查询：${query}`)).toBeNull()
  })

  it('超长路径中间省略展示，title 悬停保留完整路径', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'read_file',
          arguments: { path: LONG_TMP_PATH },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    // 完整路径不整段出现在文本节点里
    expect(screen.queryByText(LONG_TMP_PATH)).toBeNull()
    // 中间省略：头尾保留 + 省略号，完整值在 title 上
    const pathEl = screen.getByTitle(LONG_TMP_PATH)
    expect(pathEl.textContent).toContain('…')
    expect(pathEl.textContent!.startsWith('/private/var')).toBe(true)
    expect(pathEl.textContent!.endsWith('stdout.log')).toBe(true)
  })

  it('长 query 折叠为 line-clamp 并提供展开按钮，点击后展开', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const longQuestion = '请帮我找出：1、搜索框的元素 ref 和 selector；2、页面上有哪些可交互元素（按钮、输入框、链接等）的 ref 列表。只返回关键信息。'.repeat(3)

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'grep_search',
          arguments: { path: '/tmp/a.log', query: longQuestion },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    const textEl = screen.getByText(longQuestion)
    expect(textEl.className).toContain('line-clamp-3')

    fireEvent.click(screen.getByText('approval.expand'))
    expect(screen.getByText(longQuestion).className).not.toContain('line-clamp-3')
    expect(screen.getByText('approval.collapse')).toBeTruthy()
  })

  it('无结构化参数时回退展示后端 description（旧 payload 兼容）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'some_unknown_tool',
          description: '后端拼好的操作摘要',
          arguments: { foo: 'bar' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('后端拼好的操作摘要')).toBeTruthy()
  })

  it('workspace_out 理由行已含路径说明时，不再重复渲染「工作区外路径」小标签', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'read_file',
          arguments: { path: LONG_TMP_PATH },
          decision_reason: { type: 'workspace_out', kind: 'path', path: LONG_TMP_PATH },
          workspace_zone: 'outside',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByText('approval.zoneOutside')).toBeNull()
  })

  it('非 workspace_out 理由的 outside zone 仍渲染「工作区外路径」小标签', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'read_file',
          arguments: { path: '/tmp/x' },
          workspace_zone: 'outside',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('approval.zoneOutside')).toBeTruthy()
  })

  it('「添加文件夹并允许」按钮带完整路径 title（UUID 目录名可悬停查全）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    appendSessionAllowedPathMock.mockClear()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-uuid',
          tool_call_id: 'call-uuid',
          tool_name: 'read_file',
          decision_reason: { type: 'workspace_out', kind: 'path', path: LONG_TMP_PATH },
          workspace_zone: 'outside',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    const parentDir = LONG_TMP_PATH.slice(0, LONG_TMP_PATH.lastIndexOf('/'))
    const btn = screen.getByTitle(parentDir)
    expect(btn.tagName).toBe('BUTTON')
  })

  it('新增 i18n 字段标签在 zh-CN / en-US 均已配置', async () => {
    const zh = (await import('../../../../i18n/locales/zh-CN/chat.json')).default as {
      approval: { field: Record<string, string>; expand: string; collapse: string }
    }
    const en = (await import('../../../../i18n/locales/en-US/chat.json')).default as {
      approval: { field: Record<string, string>; expand: string; collapse: string }
    }
    for (const locale of [zh, en]) {
      expect(locale.approval.expand).toBeTruthy()
      expect(locale.approval.collapse).toBeTruthy()
      for (const key of ['command', 'path', 'url', 'query', 'pattern', 'skill', 'args']) {
        expect(locale.approval.field[key]).toBeTruthy()
      }
    }
  })
})

describe('ApprovalPanel · v0.4 W1.5 batch 形态新增字段', () => {
  it('卡片头展示 runtime_mode 中文标签（陪跑 / 托管 / 定时 / 批处理）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    const { rerender } = render(
      <ApprovalPanel
        actionRequests={[{ tool_name: 'list_directory' }]}
        onSubmit={vi.fn()}
        runtimeMode="interactive"
      />,
    )
    expect(screen.getByText('陪跑')).toBeTruthy()

    rerender(
      <ApprovalPanel
        actionRequests={[{ tool_name: 'list_directory' }]}
        onSubmit={vi.fn()}
        runtimeMode="solo"
      />,
    )
    expect(screen.getByText('托管')).toBeTruthy()

    rerender(
      <ApprovalPanel
        actionRequests={[{ tool_name: 'list_directory' }]}
        onSubmit={vi.fn()}
        runtimeMode="batch"
      />,
    )
    expect(screen.getByText('批处理')).toBeTruthy()
  })

  it('decision_reason.type 在条目下展示 fallback 文案（i18n key 缺失时显示 reason.type 原文）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'rm -rf build' },
          // 故意用一个不会在 i18n resources 里注册的 reason type；
          // 之前用的 `rule_high_risk_allowlist_miss` 现在已配置（i18n 会翻译），
          // 这里换成必定无注册的字符串确保 fallback 分支被实测到。
          decision_reason: { type: 'nonexistent_reason_for_test_abc' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    // i18n key approval.reason.nonexistent_reason_for_test_abc 未配置 →
    // ApprovalPanel 退化为显示 reason.type 原文，UI 仍可读。
    expect(screen.getByText(/nonexistent_reason_for_test_abc/)).toBeTruthy()
  })

  // L-W6-16（2026-05-03 W6 M4）：新增断言 — 按 type 提取字段喂 i18n 模板真的生效。
  // stub 模式下 i18n key 不翻译（t() 返回 key 本身），所以文案降级为 reason.type；
  // 真机 i18n 初始化后会显示 "命中危险命令规则 rm-rf-system-root，系统直接拒绝"。
  // 本 case 的最小断言：至少 fallback 路径不崩，且 reason.type 真的出现在 UI。
  it('decision_reason 带完整字段（hardline_command + pattern）不崩，type 回退可见', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'rm -rf /' },
          decision_reason: { type: 'hardline_command', pattern: 'rm-rf-system-root' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('card.terminal')).toBeTruthy()
    expect(screen.queryByText('run_terminal_command')).toBeNull()
    // i18n stub 下未翻译，reason type 原文作为 fallback 出现（真机 i18n 下会拿到
    // 插了 pattern 的完整中文文案）
    expect(screen.getByText(/hardline_command/)).toBeTruthy()
  })

  // ── ：user_visible_reason 兜底（Live 取证发现 raw type 裸奔）──
  //
  // 背景：destructive_in_workspace_ask 上线时 locale 未配 key，审批面板 reason
  // 描述区直接显示 raw 字符串 `destructive_in_workspace_ask`。修复分两层：
  //   1. locale 补 approval.reason.destructive_in_workspace_ask（zh/en）
  //   2. i18n 未覆盖时优先渲染 runtime 透传的 user_visible_reason（judge
  //      Decision.userVisibleReason），最后才裸奔 raw type
  // 测试环境 react-i18next stub 的 t() 恒返回 key（i18n 永远未命中），正好可以
  // 实测 fallback 链的第 2、3 层。
  it('#985 未知 reason type + user_visible_reason → 渲染人话文案而不是 raw type', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'delete_file',
          arguments: { path: '/ws/scratch.txt' },
          decision_reason: { type: 'destructive_in_workspace_ask', path: '/ws/scratch.txt' },
          user_visible_reason: '即将删除文件，请确认',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('即将删除文件，请确认')).toBeTruthy()
    expect(screen.queryByText(/destructive_in_workspace_ask/)).toBeNull()
  })

  it('#985 未知 reason type 无 user_visible_reason → 仍回退 raw type（保底可读，行为不变）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'delete_file',
          arguments: { path: '/ws/scratch.txt' },
          decision_reason: { type: 'nonexistent_reason_no_uvr' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText(/nonexistent_reason_no_uvr/)).toBeTruthy()
  })

  it('#985 destructive_in_workspace_ask 的 i18n 文案已配置（zh-CN / en-US，带 {{path}} 插值）', async () => {
    // stub i18n 下无法走真翻译，这里直接断言 locale JSON 里 key 存在——
    // 防止未来重构 locale 时把这个 key 弄丢导致 UI 再次裸奔。
    const zh = (await import('../../../../i18n/locales/zh-CN/chat.json')).default as {
      approval: { reason: Record<string, string> }
    }
    const en = (await import('../../../../i18n/locales/en-US/chat.json')).default as {
      approval: { reason: Record<string, string> }
    }
    expect(zh.approval.reason.destructive_in_workspace_ask).toContain('{{path}}')
    expect(zh.approval.reason.destructive_in_workspace_ask).toContain('删除')
    expect(en.approval.reason.destructive_in_workspace_ask).toContain('{{path}}')
    expect(en.approval.reason.destructive_in_workspace_ask.toLowerCase()).toContain('delet')
  })

  it('点 reject 后展开 rejection_message 输入框，提交时 decision 携带 rejection_message', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    const onSubmit = vi.fn()
    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-1',
          tool_call_id: 'call-1',
          tool_name: 'run_terminal_command',
          arguments: { command: 'rm -rf /' },
        }]}
        onSubmit={onSubmit}
      />,
    )

    //  UI：底部操作区 [升档] [拒绝] [记住+范围] [允许]；i18n stub 下按钮文本
    // 是 i18n key 原文（`approval.reject` / `approval.allow`）。
    // 首次点"拒绝"展开 rejection_message 输入框；再次点同一按钮才触发 handleRejectAll。
    const rejectBtn = screen.getByText('approval.reject').closest('button')!
    fireEvent.click(rejectBtn)

    // 切到 reject 后 rejection_message 输入框出现
    const textareaCandidates = document.querySelectorAll<HTMLTextAreaElement>('textarea')
    expect(textareaCandidates.length).toBeGreaterThan(0)
    const textarea = textareaCandidates[0]
    fireEvent.change(textarea, { target: { value: '太危险了' } })

    // 再次点同一个"拒绝"按钮 → handleRejectAll 提交 reject decision
    fireEvent.click(screen.getByText('approval.reject').closest('button')!)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    const decisions = onSubmit.mock.calls[0][0]
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      request_id: 'req-1',
      tool_call_id: 'call-1',
      decision: 'reject',
      rejection_message: '太危险了',
    })
  })

  it('workspace_out 文件路径按钮添加父目录并立即允许当前请求', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()
    appendSessionAllowedPathMock.mockClear()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-file',
          tool_call_id: 'call-file',
          tool_name: 'read_file',
          decision_reason: { type: 'workspace_out', kind: 'path', path: '/Users/x/proj/src/main.ts' },
          workspace_zone: 'outside',
        }]}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /添加 src 文件夹并允许|approval.addFolderAndAllow/ }))

    // 单根契约 §2.4 P0 修复：审批通过 → IPC 推 sessionApprovedPaths（session 内有效），
    // 不再 addSpaceFolder 写 store（写 store 但不授权的假修复 commit 6 已删）。
    expect(appendSessionAllowedPathMock).toHaveBeenCalledWith({
      spaceId: 'space-1',
      path: '/Users/x/proj/src',
    })
    expect(onSubmit).toHaveBeenCalledWith([expect.objectContaining({
      request_id: 'req-file',
      tool_call_id: 'call-file',
      decision: 'approve',
      scope: 'once',
    })])
  })

  it('workspace_out 路径为 <unknown> 时不渲染添加文件夹按钮', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-unknown',
          tool_call_id: 'call-unknown',
          tool_name: 'glob_search',
          decision_reason: { type: 'workspace_out', kind: 'path', path: UNKNOWN_WORKSPACE_OUT_PATH },
          workspace_zone: 'outside',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: /添加 .* 文件夹并允许|approval.addFolderAndAllow/ })).toBeNull()
  })
})

describe('ApprovalPanel · 键盘 ⌘↵ 按记住状态分发', () => {
  // 键盘 handler 挂在 document 上，dispatch 同时带 ctrlKey+metaKey 以覆盖
  // IS_MAC 两种平台判定（jsdom 下 navigator.platform 为空 → 走 ctrlKey）。
  function pressModEnter() {
    fireEvent.keyDown(document, {
      key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, metaKey: true,
    })
  }

  it('默认记住（空间内）时 ⌘↵ 提交 scope=always', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-kbd',
          tool_call_id: 'call-kbd',
          tool_name: 'run_terminal_command',
          arguments: { command: 'npm install' },
          allowed_scopes: ['once', 'thread', 'always'],
        }]}
        onSubmit={onSubmit}
      />,
    )

    pressModEnter()

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0][0]).toMatchObject({
      request_id: 'req-kbd',
      decision: 'approve',
      scope: 'always',
    })
  })

  it('抬起记住后 ⌘↵ 提交 scope=once（仅本次）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-kbd',
          tool_call_id: 'call-kbd',
          tool_name: 'run_terminal_command',
          arguments: { command: 'npm install' },
          allowed_scopes: ['once', 'thread', 'always'],
        }]}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.click(screen.getByTestId('approval-remember-toggle'))
    pressModEnter()

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0][0]).toMatchObject({
      request_id: 'req-kbd',
      decision: 'approve',
      scope: 'once',
    })
  })

  it('仅允许 once 时隐藏记住选项并提交 scope=once', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-strict',
          tool_call_id: 'call-strict',
          tool_name: 'run_terminal_command',
          arguments: { command: 'sudo reboot' },
          allowed_scopes: ['once'],
        }]}
        onSubmit={onSubmit}
      />,
    )

    expect(screen.queryByTestId('approval-remember-toggle')).toBeNull()
    expect(screen.queryByTestId('approval-remember-scope')).toBeNull()
    fireEvent.click(screen.getByTestId('approval-allow'))

    expect(onSubmit).toHaveBeenCalledWith([expect.objectContaining({
      request_id: 'req-strict',
      tool_call_id: 'call-strict',
      decision: 'approve',
      scope: 'once',
    })])
  })
})

describe('ApprovalPanel · 长内容布局', () => {
  it('长操作列表在面板内部滚动，底部允许按钮仍可点击', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()
    const actionRequests = Array.from({ length: 24 }, (_, i) => ({
      request_id: `req-${i}`,
      tool_call_id: `call-${i}`,
      tool_name: 'run_terminal_command',
      description: `长命令说明 ${i} ${'x'.repeat(120)}`,
      arguments: {
        command: `printf "${'very-long-command-argument-'.repeat(6)}${i}"`,
        cwd: `/Users/seda/workspace/project-${i}`,
      },
    }))

    render(
      <ApprovalPanel
        actionRequests={actionRequests}
        message={'这批操作内容较多，需要在面板内部滚动查看。'.repeat(12)}
        onSubmit={onSubmit}
      />,
    )

    const panel = screen.getByRole('group', { name: /review.title|请确认 Agent 操作/ })
    const body = screen.getByTestId('approval-panel-body')
    const footer = screen.getByTestId('approval-panel-footer')

    expect(panel.className).toContain('max-h-[min(60vh,32rem)]')
    expect(panel.className).toContain('flex')
    expect(body.className).toContain('flex-1')
    expect(body.className).toContain('overflow-y-auto')
    expect(footer.className).toContain('shrink-0')

    // 抬起「记住」toggle + 允许 = 仅本次（旧「这次允许」）
    fireEvent.click(screen.getByTestId('approval-remember-toggle'))
    fireEvent.click(screen.getByTestId('approval-allow'))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toHaveLength(actionRequests.length)
    expect(onSubmit.mock.calls[0][0][0]).toMatchObject({
      request_id: 'req-0',
      tool_call_id: 'call-0',
      decision: 'approve',
      scope: 'once',
    })
  })

  it('「记住 → 对话内」+ 允许 提交 scope=thread', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-platform',
          tool_call_id: 'call-platform',
          tool_name: 'browser.open',
          description: 'open example.com',
          allowed_scopes: ['once', 'thread', 'always'],
        }]}
        onSubmit={onSubmit}
      />,
    )

    // 打开范围下拉 → 选「对话内」→ 允许
    fireEvent.click(screen.getByTestId('approval-remember-scope'))
    fireEvent.click(screen.getByTestId('approval-remember-scope-thread'))
    fireEvent.click(screen.getByTestId('approval-allow'))

    expect(onSubmit).toHaveBeenCalledWith([expect.objectContaining({
      request_id: 'req-platform',
      tool_call_id: 'call-platform',
      decision: 'approve',
      scope: 'thread',
    })])
  })

  it('allowed_scopes 不含 thread 时不渲染范围切换三角（只剩空间内一档）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-platform',
          tool_call_id: 'call-platform',
          tool_name: 'browser.open',
          allowed_scopes: ['once', 'always'],
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('approval-remember-scope')).toBeNull()
    // toggle 仍在，文字固定为「在空间内记住」（i18n stub 显示 key）
    expect(screen.getByTestId('approval-remember-toggle').textContent).toContain('approval.rememberInSpace')
  })

  it('平台审批：记住（默认空间内）+ 允许 提交 scope=always（不带 pattern_key / decision_kind）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-platform',
          tool_call_id: 'call-platform',
          tool_name: 'browser.open',
          description: 'open example.com',
          allowed_scopes: ['once', 'thread', 'always'],
        }]}
        onSubmit={onSubmit}
        supportsAlwaysGranularity={false}
      />,
    )

    // 颗粒度子项彻底移除
    expect(screen.queryByText('approval.granularityExact')).toBeNull()
    expect(screen.queryByText('approval.granularityPattern')).toBeNull()

    // 「记住」toggle 默认按下 + 默认范围「空间内」→ 允许即 always
    expect(screen.getByTestId('approval-remember-toggle').getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByTestId('approval-allow'))

    expect(onSubmit).toHaveBeenCalledWith([{
      request_id: 'req-platform',
      tool_call_id: 'call-platform',
      decision: 'approve',
      scope: 'always',
    }])
  })

  it('平台审批：抬起记住 + 允许 提交 scope=once', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-platform',
          tool_call_id: 'call-platform',
          tool_name: 'browser.open',
          description: 'open example.com',
          allowed_scopes: ['once', 'thread', 'always'],
        }]}
        onSubmit={onSubmit}
        supportsAlwaysGranularity={false}
      />,
    )

    fireEvent.click(screen.getByTestId('approval-remember-toggle'))
    fireEvent.click(screen.getByTestId('approval-allow'))

    expect(onSubmit).toHaveBeenCalledWith([{
      request_id: 'req-platform',
      tool_call_id: 'call-platform',
      decision: 'approve',
      scope: 'once',
    }])
  })

  it('Agent 工具审批：默认记住（空间内）+ 允许 按更安全的 pattern 档记忆', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-tool',
          tool_call_id: 'call-tool',
          tool_name: 'run_terminal_command',
          arguments: { command: 'npm install' },
          allowed_scopes: ['once', 'thread', 'always'],
        }]}
        onSubmit={onSubmit}
      />,
    )

    // 无颗粒度下拉；默认记住+空间内 → 允许
    expect(screen.queryByText('approval.granularityExact')).toBeNull()
    fireEvent.click(screen.getByTestId('approval-allow'))

    // Agent 工具默认走 pattern（同类+工作区内，原推荐档）
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(onSubmit.mock.calls[0][0][0]).toMatchObject({
      request_id: 'req-tool',
      tool_call_id: 'call-tool',
      decision: 'approve',
      scope: 'always',
      decision_kind: 'pattern',
    })
  })

  it('升档按钮升级成功后放行本批（stub onUpgraded → approve once）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-up',
          tool_call_id: 'call-up',
          tool_name: 'run_terminal_command',
          arguments: { command: 'npm install' },
        }]}
        onSubmit={onSubmit}
        sessionId="session-1"
      />,
    )

    fireEvent.click(screen.getByTestId('approval-tier-upgrade'))

    expect(onSubmit).toHaveBeenCalledWith([expect.objectContaining({
      request_id: 'req-up',
      tool_call_id: 'call-up',
      decision: 'approve',
      scope: 'once',
    })])
  })

  it('底部按钮禁止压缩换行，窄面板下 flex-wrap 折行', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    const footer = screen.getByTestId('approval-panel-footer')
    const buttonRow = footer.querySelector(':scope > div:last-child')!
    expect(buttonRow.className).toContain('flex-wrap')
    expect(buttonRow.className).toContain('justify-end')

    // 折行单元 = 按钮行的直接子元素（拒绝 / 记住胶囊 / 允许 / 升档 stub），
    // 每个都必须整体不可压缩不换行；胶囊内部的子按钮由胶囊统一兜住。
    const units = Array.from(buttonRow.children)
    expect(units.length).toBeGreaterThanOrEqual(3)
    for (const unit of units) {
      expect(unit.className).toContain('whitespace-nowrap')
      expect(unit.className).toContain('shrink-0')
    }
  })

  it('Project 非 Owner 只看到等待态：不渲染审批详情，也没有操作按钮（决策 Q5 遮蔽）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-team',
          tool_call_id: 'call-team',
          tool_name: 'run_terminal_command',
          arguments: { command: 'touch team.txt' },
        }]}
        onSubmit={onSubmit}
        teamSpaceWaiting
        canResolve={false}
        executionOwnerName="Owner User"
      />,
    )

    // 等待态文案可见
    expect(screen.getByText('approval.teamSpaceReadonlyWaiting')).toBeTruthy()
    expect(screen.getByTestId('approval-panel-body-readonly')).toBeTruthy()
    // 审批具体内容（工具名/命令）不渲染给成员
    expect(screen.queryByTestId('approval-panel-body')).toBeNull()
    expect(screen.queryByText(/touch team\.txt/)).toBeNull()
    // 操作按钮整体不渲染
    expect(screen.queryByTestId('approval-panel-footer')).toBeNull()
    expect(screen.queryByText('approval.reject')).toBeNull()
    expect(screen.queryByTestId('approval-allow')).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('Project Owner 视角保留完整审批详情与操作按钮', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onSubmit = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-team',
          tool_call_id: 'call-team',
          tool_name: 'run_terminal_command',
          arguments: { command: 'touch team.txt' },
        }]}
        onSubmit={onSubmit}
        teamSpaceWaiting
        canResolve
        executionOwnerName="Owner User"
      />,
    )

    expect(screen.getByText('approval.teamSpaceOwnerAction')).toBeTruthy()
    expect(screen.getByTestId('approval-panel-body')).toBeTruthy()
    expect(screen.getByText(/touch team\.txt/)).toBeTruthy()
    const allowBtn = screen.getByTestId('approval-allow') as HTMLButtonElement
    expect(allowBtn.disabled).toBe(false)
    fireEvent.click(allowBtn)
    // 默认记住+空间内 → 走异步的 pattern key 构建后提交。
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it('带 subagent_context 时渲染可点击的来源标识', async () => {
    scrollToToolCallMock.mockClear()
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-sub',
          tool_call_id: 'call-sub',
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
          subagent_context: {
            parent_tool_call_id: 'toolu_parent_1',
            subagent_run_id: 'run-sub-1',
            label: '调研助手',
          },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    const sourceBtn = screen.getByTestId('approval-subagent-source')
    expect(sourceBtn.textContent).toMatch(/调研助手|approval\.subagentSource/)

    fireEvent.click(sourceBtn)
    expect(scrollToToolCallMock).toHaveBeenCalledWith(
      'toolu_parent_1',
      expect.objectContaining({ onMissing: expect.any(Function) }),
    )
  })
})

describe('ApprovalPanel · 风险等级归一展示（ /  收敛）', () => {
  it('灾难性判决理由（hardline_confirm）→ 高风险中文警示', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'sudo shutdown -h now' },
          risk_level: 'strict',
          decision_reason: { type: 'hardline_confirm' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByTestId('approval-risk-strict')).toBeTruthy()
    expect(screen.getByTestId('approval-risk-strict').textContent).toMatch(/approval\.riskStrict|高风险/)
  })

  it('高危不可逆判决理由（destructive_in_workspace_ask）→ 即使名义风险仅 medium 也出红字警示', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'delete_file',
          arguments: { path: '/ws/scratch.txt' },
          risk_level: 'medium',
          decision_reason: { type: 'destructive_in_workspace_ask', path: '/ws/scratch.txt' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.getByTestId('approval-risk-strict')).toBeTruthy()
    expect(screen.queryByTestId('approval-risk-review')).toBeNull()
  })

  it('名义 strict 但非灾难/不可逆理由 → 不再整行红字警示（ 收敛）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'rm -rf build' },
          risk_level: 'strict',
          decision_reason: { type: 'classifier_decided' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('approval-risk-strict')).toBeNull()
  })

  it('wire medium → 中性确认提示，不再写「写操作」', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'write_file',
          arguments: { path: '/tmp/x' },
          risk_level: 'medium',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    const row = screen.getByTestId('approval-risk-review')
    expect(row).toBeTruthy()
    expect(row.textContent).toMatch(/approval\.riskReview|建议确认/)
    expect(row.textContent).not.toMatch(/写操作/)
  })

  it('wire low / safe 不展示额外警示行', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'read_file',
          arguments: { path: '/tmp/x' },
          risk_level: 'low',
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('approval-risk-strict')).toBeNull()
    expect(screen.queryByTestId('approval-risk-review')).toBeNull()
  })

  it('注册表 strict（agent 子工具）无灾难/不可逆理由 → 不出红字警示（ 收敛）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'agent',
          arguments: { task: 'research' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('approval-risk-strict')).toBeNull()
    expect(screen.queryByTestId('approval-risk-review')).toBeNull()
  })
})

/**
 * ：ApprovalPanel 的 onDismiss（手动放弃）+ onExpired（倒计时归零）出口。
 *
 * 死锁现象：submit 失败显示 request timeout 后 pending 不清，Composer 一直停在
 * 待确认态。修复给 ApprovalPanel 加 onDismiss 按钮（submitError 时渲染）+
 * onExpired 接入（倒计时归零自动调），两路都路由到 store 的
 * dismissApprovalForSession 清 pending 恢复输入。
 */
describe('ApprovalPanel · 放弃审批出口 ', () => {
  it('submitError + onDismiss 渲染"放弃审批"按钮，点击调 onDismiss', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onDismiss = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          request_id: 'req-1',
          tool_call_id: 'call-1',
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
        submitError="审批未送达 Agent，请确认执行设备在线后重试"
        onDismiss={onDismiss}
      />,
    )

    const dismissBtn = screen.getByTestId('approval-dismiss-link')
    expect(dismissBtn.textContent).toMatch(/approval\.dismissToRestore|放弃审批/)
    fireEvent.click(dismissBtn)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('未传 onDismiss 时不渲染"放弃审批"按钮（兼容旧调用方）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
        submitError="some error"
      />,
    )

    expect(screen.queryByTestId('approval-dismiss-link')).toBeNull()
  })

  it('已过期（isExpired）时不渲染"放弃审批"按钮——onExpired 已自动清 pending', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onDismiss = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
        submitError="some error"
        expiresAt={Date.now() - 60_000}
        onDismiss={onDismiss}
      />,
    )

    // isExpired 时 submitError 块整体不渲染（!isExpired 条件），按钮也不渲染
    expect(screen.queryByTestId('approval-dismiss-link')).toBeNull()
  })

  it('倒计时归零时调用 onExpired（ChatInput 接入后路由到 dismissApprovalForSession(expired)）', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')
    const onExpired = vi.fn()

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
        expiresAt={Date.now() - 60_000}
        onExpired={onExpired}
      />,
    )

    // useApprovalCountdown 的 useEffect 在 mount 后立即 tick() 一次；
    // expiresAt 已过期 → left<=0 → onExpired 被调用。
    // useEffect 异步执行，等一个 setTimeout 让 microtask 队列跑完。
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(onExpired).toHaveBeenCalled()
  })
})

describe('ApprovalPanel · 动效入场与视觉层级', () => {
  it('首次挂载根节点带 chat-motion-approval-enter，且不渲染侧边色条', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    const { rerender } = render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    const panel = screen.getByTestId('approval-panel')
    const panelClass = String(panel.className)
    expect(panelClass).toContain('chat-motion-approval-enter')
    expect(panelClass).not.toContain('overflow-hidden')
    expect(panelClass.includes('animate-pulse')).toBe(false)
    expect(panelClass.includes('animate-spin')).toBe(false)

    expect(screen.queryByTestId('approval-severity-bar')).toBeNull()

    // 内部状态更新（打开拒绝输入）不 remount → 入场 class 仍在，无持续闪烁
    fireEvent.click(screen.getByText('approval.reject').closest('button')!)
    rerender(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'echo hi' },
        }]}
        onSubmit={vi.fn()}
      />,
    )
    const afterClass = String(screen.getByTestId('approval-panel').className)
    expect(afterClass).toContain('chat-motion-approval-enter')
    expect(afterClass.includes('animate-pulse')).toBe(false)
    expect(afterClass.includes('animate-spin')).toBe(false)
  }, 15_000)

  it('灾难性判决理由也不渲染侧边色条', async () => {
    const { ApprovalPanel } = await import('../ApprovalPanel')

    render(
      <ApprovalPanel
        actionRequests={[{
          tool_name: 'run_terminal_command',
          arguments: { command: 'rm -rf /' },
          decision_reason: { type: 'hardline_confirm' },
        }]}
        onSubmit={vi.fn()}
      />,
    )

    expect(screen.queryByTestId('approval-severity-bar')).toBeNull()
  }, 15_000)
})
