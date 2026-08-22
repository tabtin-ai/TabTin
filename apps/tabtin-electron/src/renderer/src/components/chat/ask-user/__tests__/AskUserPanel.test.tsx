/**
 * AskUserPanel 顶层路由 + 三件套子 Panel 单测（W4 R3 / 2026-05-11）。
 *
 * 历史：
 *   - W5 时单测按 intent / formMode 软联合调；W7 改为按 `state.kind` discriminate。
 *   - W4 一度合一为单 ask_user 工具；R3 复盘后恢复三件套并存。
 *
 * 覆盖：
 *   1. choice 子 Panel：questions[] / options[] 渲染、Other 弹自由文本、header chip、
 *      option.preview 代码块、allow_multiple、submitError、skip、disabled
 *   2. form 子 Panel：路由到 AskFormPanel + text_fallback 模式提交
 *   3. approval 子 Panel：路由到 RequestApprovalPanel + 双按钮决策回调
 */

import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  AskUserRequestStateChoice,
  AskUserRequestStateForm,
  AskUserRequestStateApproval,
} from '@stores/chat/shared/types'
import type { AskUserQuestion } from '@tabtin/chat-client'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown> | string) => {
      const fallback = typeof options === 'string' ? options : options?.defaultValue
      if (typeof fallback !== 'string') return key
      const vars = typeof options === 'string' ? {} : (options ?? {})
      return fallback.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => String(vars[token] ?? ''))
    },
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  toast: vi.fn(),
}))

// AskFormPanel fields 模式依赖 SchemaFormRenderer，单测里 mock 掉避免拉真依赖；
// text_fallback 模式不依赖 renderer，仍能完整跑通 textarea 提交链路。
vi.mock('../../composer-presets/SchemaFormRenderer', () => ({
  SchemaFormRenderer: () => null,
}))

const baseStateFields = {
  sessionId: 's',
  threadId: 't',
  toolCallId: 'tc',
}

const sampleQuestion = (overrides?: Partial<AskUserQuestion>): AskUserQuestion => ({
  id: 'q1',
  prompt: '怎么同步？',
  options: [
    { id: 'fast', label: '快速', description: '只同步最近修改的文件。' },
    { id: 'full', label: '完整', description: '重新扫描整个目录，耗时更久。' },
    // 模拟 runtime normalize 后注入的 Other 选项
    { id: '__other__', label: 'Other', description: 'Use a custom answer not covered by the listed options.' },
  ],
  ...overrides,
})

const choiceState = (overrides?: Partial<AskUserRequestStateChoice>): AskUserRequestStateChoice => ({
  ...baseStateFields,
  kind: 'choice',
  questions: [sampleQuestion()],
  title: '选择同步方式',
  ...overrides,
})

const formState = (overrides?: Partial<AskUserRequestStateForm>): AskUserRequestStateForm => ({
  ...baseStateFields,
  kind: 'form',
  fields: [{ key: 'url', label: '链接', required: true }],
  addons: [{ key: 'images', label: '图片', default_active: true }],
  formMode: 'text_fallback',
  title: '请填写参数',
  ...overrides,
})

const approvalState = (overrides?: Partial<AskUserRequestStateApproval>): AskUserRequestStateApproval => ({
  ...baseStateFields,
  kind: 'approval',
  rationale: '将创建 5 个文件',
  riskLevel: 'review',
  title: '请确认',
  ...overrides,
})

describe('AskUserPanel · kind=choice (ask_user)', () => {
  it('渲染 questions[] + options[] description（基础形态）', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel state={choiceState()} onChoiceSubmit={vi.fn()} />,
    )

    expect(screen.getByText('选择同步方式')).toBeTruthy()
    expect(screen.getByText('怎么同步？')).toBeTruthy()
    expect(screen.getByText('只同步最近修改的文件。')).toBeTruthy()
    expect(screen.getByText('重新扫描整个目录，耗时更久。')).toBeTruthy()
  })

  it('choice 外壳用实底 bg-background，避免叠在 composer 灰托盘上透出蒙层', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(<AskUserPanel state={choiceState()} onChoiceSubmit={vi.fn()} />)

    const panel = screen.getByTestId('ask-user-choice-panel')
    expect(panel.className).toContain('bg-background')
    expect(panel.className).not.toMatch(/\bbg-muted\//)
  })

  it('用户单选 → onChoiceSubmit 收到 selected_options 数组', async () => {
    const onChoiceSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(<AskUserPanel state={choiceState()} onChoiceSubmit={onChoiceSubmit} />)

    fireEvent.click(screen.getByText('快速'))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    expect(onChoiceSubmit).toHaveBeenCalledWith([
      { question_id: 'q1', selected_options: ['fast'], free_text: undefined },
    ])
  })

  it('选 Other 选项 → 弹自由文本输入框 + 必须填文本才能提交', async () => {
    const onChoiceSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(<AskUserPanel state={choiceState()} onChoiceSubmit={onChoiceSubmit} />)

    expect(screen.getByText('填写上述选项之外的自定义回答')).toBeTruthy()
    fireEvent.click(screen.getByText('其他'))
    const input = screen.getByPlaceholderText('输入自定义回答...')
    expect(input).toBeTruthy()

    expect((screen.getByRole('button', { name: '提交回答' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(input, { target: { value: '我想用 mongoose' } })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    expect(onChoiceSubmit).toHaveBeenCalledWith([
      { question_id: 'q1', selected_options: ['__other__'], free_text: '我想用 mongoose' },
    ])
  })

  it('other_option 定制文案 → Other 卡片展示定制 label/description', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({
          questions: [
            sampleQuestion({
              other_option: {
                id: '__other__',
                label: '其他页面',
                description: '你告诉我具体页面和要验证的功能',
              },
              options: [
                { id: 'login', label: '登录页', description: '验登录。' },
                { id: 'model', label: '模型配置页', description: '验模型。' },
                {
                  id: '__other__',
                  label: '其他页面',
                  description: '你告诉我具体页面和要验证的功能',
                },
              ],
            }),
          ],
        })}
        onChoiceSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('其他页面')).toBeTruthy()
    expect(screen.getByText('你告诉我具体页面和要验证的功能')).toBeTruthy()
    expect(screen.queryByText('其他', { exact: true })).toBeNull()
    expect(screen.queryByText('填写上述选项之外的自定义回答')).toBeNull()
  })

  it('header 字段渲染为 chip', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({ questions: [sampleQuestion({ header: 'Library' })] })}
        onChoiceSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('Library')).toBeTruthy()
  })

  it('allow_multiple=true 时选多个选项 → 提交 selected_options 包含全部', async () => {
    const onChoiceSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({
          questions: [
            sampleQuestion({
              id: 'features',
              prompt: '需要哪些功能？',
              allow_multiple: true,
              options: [
                { id: 'auth', label: '认证', description: '登录授权。' },
                { id: 'cache', label: '缓存', description: '提速读取。' },
                { id: 'queue', label: '队列', description: '异步任务。' },
              ],
            }),
          ],
        })}
        onChoiceSubmit={onChoiceSubmit}
      />,
    )

    fireEvent.click(screen.getByText('认证'))
    fireEvent.click(screen.getByText('缓存'))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    expect(onChoiceSubmit).toHaveBeenCalledTimes(1)
    const answers = onChoiceSubmit.mock.calls[0][0]
    expect(answers[0].question_id).toBe('features')
    expect(new Set(answers[0].selected_options)).toEqual(new Set(['auth', 'cache']))
  })

  it('submitError → 红条提示', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({ submitError: '本地 Runtime 未找到待回答的问题' })}
        onChoiceSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText('本地 Runtime 未找到待回答的问题')).toBeTruthy()
  })

  it('option.preview 渲染为代码块（mockup / snippet 比较）', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({
          questions: [
            sampleQuestion({
              options: [
                { id: 'a', label: 'A', description: '布局 A', preview: '+--+--+\n|  |  |\n+--+--+' },
                { id: 'b', label: 'B', description: '布局 B' },
              ],
            }),
          ],
        })}
        onChoiceSubmit={vi.fn()}
      />,
    )

    expect(screen.getByText(/\+--\+--\+/)).toBeTruthy()
  })

  // [#1398] 回归：选项 label 文案较长（如完整 URL）时必须换行，不得横向溢出卡片。
  // label 的 span 必须带 break-words / overflow-wrap:anywhere + min-w-0，
  // 与同卡片 description / preview 一致 —— 否则长 URL 撑破选项按钮边界。
  it('选项 label 较长时 span 带换行类（不溢出卡片）', async () => {
    const longUrl = 'https://example.com/very/long/path/that/keeps/going?with=query&and=more&params=overflow'
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({
          questions: [
            sampleQuestion({
              options: [{ id: 'long', label: longUrl }],
            }),
          ],
        })}
        onChoiceSubmit={vi.fn()}
      />,
    )

    const labelSpan = screen.getByText(longUrl)
    expect(labelSpan.className).toContain('break-words')
    expect(labelSpan.className).toContain('[overflow-wrap:anywhere]')
    expect(labelSpan.className).toContain('min-w-0')
  })

  it('提供 onSkip → 渲染跳过按钮 + 点击触发回调', async () => {
    const onSkip = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel state={choiceState()} onChoiceSubmit={vi.fn()} onSkip={onSkip} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '跳过' }))
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('disabled=true → 提交按钮显示"连接已断开"且不可点击', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel state={choiceState()} disabled onChoiceSubmit={vi.fn()} />,
    )

    expect(screen.getByRole('button', { name: '连接已断开' })).toBeTruthy()
  })

  // [#1358] 回归：多组 questions × 多 options 时 ChoicePanel 不得撑爆视口。
  // 根容器必须有 max-h 限高，questions 列表区可独立滚动，footer（跳过/提交）
  // 固定在卡片底部不随内容滚走 —— 否则底部确认按钮被截断、用户无法提交。
  it('多组 questions 时根容器限高 + questions 区可滚动 + footer 始终可见', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')
    const { container } = render(
      <AskUserPanel
        state={choiceState({
          questions: [
            sampleQuestion({ id: 'q1', header: '位置' }),
            sampleQuestion({ id: 'q2', header: '功能' }),
            sampleQuestion({ id: 'q3', header: '样式' }),
          ],
        })}
        onChoiceSubmit={vi.fn()}
      />,
    )

    // 根卡片：限高 + flex 列布局 + overflow-hidden（不撑爆外层浮层）
    const card = container.firstElementChild as HTMLElement
    expect(card).toBeTruthy()
    expect(card.className).toContain('max-h-')
    expect(card.className).toContain('flex-col')
    expect(card.className).toContain('overflow-hidden')

    // questions 列表区：flex-1 + overflow-y-auto（独立滚动，不带动 footer）
    const scrollables = card.querySelectorAll('.overflow-y-auto')
    expect(scrollables.length).toBeGreaterThanOrEqual(1)
    const questionsScroll = scrollables[0] as HTMLElement
    expect(questionsScroll.className).toContain('flex-1')
    // 三组 question prompt 都在滚动区内
    expect(questionsScroll.textContent).toContain('怎么同步？')

    // footer（提交按钮）是根卡片直接子元素，不在滚动区内 —— 保证始终可见
    const submitButton = screen.getByRole('button', { name: '提交回答' })
    expect(card.contains(submitButton)).toBe(true)
    expect(questionsScroll.contains(submitButton)).toBe(false)
  })
})

describe('AskUserPanel · kind=form (ask_form)', () => {
  it('text_fallback 模式 → textarea 提交触发 onFormTextSubmit', async () => {
    const onFormTextSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={formState()}
        onChoiceSubmit={vi.fn()}
        onFormTextSubmit={onFormTextSubmit}
      />,
    )

    // text_fallback 模式下 AskFormPanel 渲染 textarea；模拟用户输入 + 点击提交。
    const textareas = screen.queryAllByRole('textbox')
    expect(textareas.length).toBeGreaterThan(0)
    fireEvent.change(textareas[0], { target: { value: '我的回答内容' } })

    // 找到提交按钮（AskFormPanel 用 i18n key askUser.submit）
    const submitButtons = screen.queryAllByRole('button').filter(b => /提交/.test(b.textContent ?? ''))
    expect(submitButtons.length).toBeGreaterThan(0)
    fireEvent.click(submitButtons[0])

    expect(onFormTextSubmit).toHaveBeenCalledWith('我的回答内容')
  })
})

describe('AskUserPanel · kind=approval (request_approval)', () => {
  it('渲染 rationale + 双按钮 → 点确认触发 onApprovalSubmit(true)', async () => {
    const onApprovalSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={approvalState()}
        onChoiceSubmit={vi.fn()}
        onApprovalSubmit={onApprovalSubmit}
      />,
    )

    expect(screen.getByText('将创建 5 个文件')).toBeTruthy()

    // 找到带"确认 / Confirm / 同意 / 执行"语义的按钮
    const buttons = screen.queryAllByRole('button')
    const approveButton = buttons.find(b => /确认|执行|同意|批准|approve|confirm/i.test(b.textContent ?? ''))
    expect(approveButton).toBeTruthy()
    if (approveButton) fireEvent.click(approveButton)

    expect(onApprovalSubmit).toHaveBeenCalledWith(true)
  })

  it('点拒绝按钮 → onApprovalSubmit(false)', async () => {
    const onApprovalSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={approvalState()}
        onChoiceSubmit={vi.fn()}
        onApprovalSubmit={onApprovalSubmit}
      />,
    )

    const buttons = screen.queryAllByRole('button')
    const declineButton = buttons.find(b => /拒绝|取消|reject|cancel|decline/i.test(b.textContent ?? ''))
    expect(declineButton).toBeTruthy()
    if (declineButton) fireEvent.click(declineButton)

    expect(onApprovalSubmit).toHaveBeenCalledWith(false)
  })
})

describe('AskUserPanel · Project 只读态（ 决策 Q5）', () => {
  it('canResolve=false → 只渲染等待 Owner 卡片，不渲染问题内容和提交按钮', async () => {
    const onChoiceSubmit = vi.fn()
    const { AskUserPanel } = await import('../AskUserPanel')

    render(
      <AskUserPanel
        state={choiceState({
          canResolve: false,
          teamSpaceExecution: {
            executionOwnerUserId: 'owner-1',
            executionOwnerDisplayName: 'user_1976',
          },
        })}
        onChoiceSubmit={onChoiceSubmit}
      />,
    )

    expect(screen.getByTestId('ask-user-panel-readonly')).toBeTruthy()
    expect(screen.getByText(/正在等待 user_1976 处理/)).toBeTruthy()
    // 具体问题内容与选项被遮蔽
    expect(screen.queryByText('怎么同步？')).toBeNull()
    expect(screen.queryByText('快速')).toBeNull()
    expect(screen.queryByRole('button', { name: '提交回答' })).toBeNull()
  })

  it('canResolve 未设置（工作空间 / 旧事件）→ 正常渲染完整面板', async () => {
    const { AskUserPanel } = await import('../AskUserPanel')

    render(<AskUserPanel state={choiceState()} onChoiceSubmit={vi.fn()} />)

    expect(screen.queryByTestId('ask-user-panel-readonly')).toBeNull()
    expect(screen.getByText('怎么同步？')).toBeTruthy()
  })
})
