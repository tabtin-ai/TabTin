/**
 * SystemNoticeBanner 测试 — W4.5-A3-followup
 *
 * 覆盖：
 *   1. 9 种 noticeType 各 1 条 fixture，断言每条都被渲染（含 title / 视觉权重 / dismiss 按钮）
 *   2. 未知 noticeType fallback（systemHandler 未来灰度新 notice_type 时不 silent drop）
 *   3. dismiss 行为：sessionStorage 持久化 + remount 后保持 dismissed
 *   4. session 切换 dismissed 不串
 *   5. 仅 'system_notice' type 被渲染（不会误命中 'tool_start' / 'thinking' 等）
 *   6. 多条 system_notice 全部渲染（：由 ChatNoticeStack 折叠，不再截断为 3 条）
 */

import React from 'react'
import { act, render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SystemNoticeBanner } from '../SystemNoticeBanner'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useAgentSettingsSheetStore } from '@stores/useAgentSettingsSheetStore'
import type { AgentStep } from '@/stores/chat/shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: Record<string, unknown>) => String(opts?.defaultValue ?? _key),
  }),
}))

const SESSION_ID = 'session-system-notice-banner'

const MS = 1_700_000_000_000

function makeNotice(noticeType: string, title: string, detail?: string, idSuffix?: string): AgentStep {
  return {
    id: `notice-${noticeType}-${idSuffix ?? Math.random().toString(36).slice(2, 8)}`,
    type: 'system_notice',
    title,
    detail,
    status: 'done',
    timestamp: MS,
    noticeType,
  }
}

/**
 * 直接 setState 写入 agentStepsBySessionId，绕过 pushAgentStepForSession 的
 * rAF batch（测试无需等 rAF；本组件订阅的是 state 字段直接读）。
 */
function seedSteps(steps: AgentStep[]): void {
  useChatRuntimeStore.setState(state => ({
    agentStepsBySessionId: {
      ...state.agentStepsBySessionId,
      [SESSION_ID]: steps,
    },
  }))
}

beforeEach(() => {
  useChatRuntimeStore.getState().reset()
  // sessionStorage 在 jsdom 里是真实可用的——保险起见每次清掉
  try { sessionStorage.clear() } catch { /* ignore */ }
})

afterEach(() => {
  try { sessionStorage.clear() } catch { /* ignore */ }
})

describe('SystemNoticeBanner', () => {
  it('渲染 9 种 noticeType 各 1 条 + 含 fallback 给未知 noticeType', () => {
    // 9 条覆盖：context_truncated / tool_failure_notice / tool_failure_nudge /
    // tool_repetition_notice / tool_repetition_nudge / subagent_spawn_blocked /
    // model_override / model_fallback / tool_timeout /
    // subagent_hitl_required / speaker_push_message
    // 同时加 1 条未知 noticeType（unknown_future_type）测 fallback。
    const FIXTURES: Array<{ noticeType: string; title: string }> = [
      { noticeType: 'context_truncated', title: '上下文已自动压缩' },
      { noticeType: 'tool_failure_notice', title: '「parse_document」已连续失败 3 次。再失败 2 次系统会提醒 Agent 换种方式尝试。' },
      { noticeType: 'tool_failure_nudge', title: '「parse_document」已连续失败 5 次。系统已提醒 Agent 换种方式尝试。' },
      { noticeType: 'tool_repetition_notice', title: '工具「web_search」最近 30 秒内被相同输入调用了 3 次' },
      { noticeType: 'tool_repetition_nudge', title: '工具「web_search」TabTin 已介入提示 Agent' },
      { noticeType: 'subagent_spawn_blocked', title: 'AI 助手暂时无法启动更多并行子任务' },
      { noticeType: 'model_override', title: 'Skill 已将模型切换为 Claude Sonnet 4' },
      { noticeType: 'model_fallback', title: '已切换到备用模型 GPT-4o' },
      { noticeType: 'tool_timeout', title: '工具「bash」执行超时（约 60s）' },
      { noticeType: 'subagent_hitl_required', title: '子 Agent「调研」等待审批' },
      { noticeType: 'speaker_push_message', title: '主助手 · A1B2 阶段性进展' },
      { noticeType: 'unknown_future_type', title: 'daemon 灰度新 notice_type fallback' },
    ]

    // 因为只展示最近 N 条，逐条独立校验
    for (const fixture of FIXTURES) {
      useChatRuntimeStore.getState().reset()
      try { sessionStorage.clear() } catch { /* ignore */ }
      seedSteps([makeNotice(fixture.noticeType, fixture.title, undefined, fixture.noticeType)])

      const { unmount } = render(<SystemNoticeBanner sessionId={SESSION_ID} />)

      const banners = screen.getAllByTestId('system-notice-banner')
      expect(banners).toHaveLength(1)
      expect(banners[0].getAttribute('data-notice-type')).toBe(fixture.noticeType)
      expect(screen.getByText(fixture.title)).toBeTruthy()
      expect(screen.getByTestId('system-notice-banner-dismiss')).toBeTruthy()

      unmount()
    }
  })

  it('未知 noticeType 走 info severity fallback（不 silent drop）', () => {
    seedSteps([makeNotice('brand_new_unseen_type', 'daemon 未来某种新通知', undefined, 'unk')])

    render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    const banner = screen.getByTestId('system-notice-banner')
    expect(banner.getAttribute('data-notice-type')).toBe('brand_new_unseen_type')
    expect(banner.getAttribute('data-severity')).toBe('info')
  })

  it('error / warning / info 三档严重度映射正确', () => {
    seedSteps([
      makeNotice('tool_timeout', '工具超时', undefined, 'err-1'),
      makeNotice('subagent_hitl_required', '等待审批', undefined, 'warn-1'),
      makeNotice('context_truncated', '上下文压缩', undefined, 'info-1'),
    ])
    render(<SystemNoticeBanner sessionId={SESSION_ID} />)

    const banners = screen.getAllByTestId('system-notice-banner')
    // 最近 3 条全部命中
    expect(banners).toHaveLength(3)
    const severities = banners.map(b => b.getAttribute('data-severity'))
    expect(severities).toContain('error')
    expect(severities).toContain('warning')
    expect(severities).toContain('info')

    // ：error 档必须用已注册的 destructive token，禁止 text-error / bg-error 死类
    const errorBanner = banners.find(b => b.getAttribute('data-severity') === 'error')
    expect(errorBanner?.className).toContain('bg-destructive')
    expect(errorBanner?.querySelector('p')?.className).toContain('text-destructive')
  })

  it('dismiss 按钮 → sessionStorage 持久化 + remount 后保持 dismissed', () => {
    seedSteps([
      makeNotice('context_truncated', '上下文已压缩', undefined, 'd-1'),
      makeNotice('model_fallback', '已切换到备用模型', undefined, 'd-2'),
    ])

    const { rerender, unmount } = render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(2)

    act(() => {
      fireEvent.click(screen.getAllByTestId('system-notice-banner-dismiss')[0])
    })

    rerender(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(1)

    // sessionStorage 真的写了
    const raw = sessionStorage.getItem(`tabtin:systemNoticeBanner:dismissed:${SESSION_ID}`)
    expect(raw).toBeTruthy()
    const dismissedIds = JSON.parse(raw!) as string[]
    expect(dismissedIds).toHaveLength(1)

    // remount（模拟用户切到别的视图再切回来）→ 仍保持 dismissed
    unmount()
    render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(1)
  })

  it('session 切换 dismissed 不串', () => {
    const OTHER_SESSION_ID = 'session-other-banner'

    // session A push 2 条 + dismiss 1 条
    seedSteps([
      makeNotice('context_truncated', 'A-1', undefined, 'a-1'),
      makeNotice('model_fallback', 'A-2', undefined, 'a-2'),
    ])
    const { rerender } = render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    act(() => {
      fireEvent.click(screen.getAllByTestId('system-notice-banner-dismiss')[0])
    })
    rerender(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(1)

    // session B push 2 条 → 各自独立
    act(() => {
      useChatRuntimeStore.setState(state => ({
        agentStepsBySessionId: {
          ...state.agentStepsBySessionId,
          [OTHER_SESSION_ID]: [
            makeNotice('tool_timeout', 'B-1', undefined, 'b-1'),
            makeNotice('tool_failure_notice', 'B-2', undefined, 'b-2'),
          ],
        },
      }))
      rerender(<SystemNoticeBanner sessionId={OTHER_SESSION_ID} />)
    })
    // 切到 session B 应该展示 B 的 2 条（A 的 dismissed 不影响 B）
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(2)
  })

  it("仅 'system_notice' type 被渲染（不串 'tool_start' / 'thinking' 等）", () => {
    seedSteps([
      makeNotice('context_truncated', '通知 1', undefined, 's-1'),
      {
        id: 'tool-1',
        type: 'tool_start',
        title: '调用 web_search',
        status: 'running',
        timestamp: MS,
      },
      {
        id: 'thinking-1',
        type: 'thinking',
        title: 'Thinking...',
        status: 'running',
        timestamp: MS,
      },
      makeNotice('model_fallback', '通知 2', undefined, 's-2'),
    ])

    render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(2)
    // 'tool_start' 和 'thinking' 不应被渲染
    expect(screen.queryByText('调用 web_search')).toBeNull()
    expect(screen.queryByText('Thinking...')).toBeNull()
  })

  it('多条 system_notice 全部渲染（5 条 push → 5 条均可见，供 ChatNoticeStack 计数）', () => {
    seedSteps([
      makeNotice('context_truncated', '通知 1（最早）', undefined, '1'),
      makeNotice('model_fallback', '通知 2', undefined, '2'),
      makeNotice('tool_failure_notice', '通知 3', undefined, '3'),
      makeNotice('tool_repetition_notice', '通知 4', undefined, '4'),
      makeNotice('speaker_push_message', '通知 5（最新）', undefined, '5'),
    ])

    render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getAllByTestId('system-notice-banner')).toHaveLength(5)
    expect(screen.getByText('通知 1（最早）')).toBeTruthy()
    expect(screen.getByText('通知 5（最新）')).toBeTruthy()
  })

  it('空 session / 无 system_notice → 不渲染容器', () => {
    // null sessionId
    const { rerender, container, unmount } = render(<SystemNoticeBanner sessionId={null} />)
    expect(container.querySelector('[data-testid="system-notice-banner-host"]')).toBeNull()

    // 有 session 但 0 条 notice
    act(() => {
      rerender(<SystemNoticeBanner sessionId={SESSION_ID} />)
    })
    expect(container.querySelector('[data-testid="system-notice-banner-host"]')).toBeNull()

    // 只有 tool_start step 也不渲染
    act(() => {
      seedSteps([
        {
          id: 'tool-only',
          type: 'tool_start',
          title: 'tool only',
          status: 'running',
          timestamp: MS,
        },
      ])
      rerender(<SystemNoticeBanner sessionId={SESSION_ID} />)
    })
    expect(container.querySelector('[data-testid="system-notice-banner-host"]')).toBeNull()
    unmount()
  })

  it('未知 noticeType + 空 title → fallback 到 "系统通知" 通用文案', () => {
    // 极端 case：systemHandler 收到 daemon 灰度新 notice_type，rawContent
    // 也是空字符串（譬如配置错误），step.title='' → 用户至少应该看到"系统通知"
    seedSteps([
      {
        id: 'edge-empty-title',
        type: 'system_notice',
        title: '',
        status: 'done',
        timestamp: MS,
        noticeType: 'gray_rollout_no_handler',
      },
    ])

    render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    const banner = screen.getByTestId('system-notice-banner')
    expect(banner).toBeTruthy()
    // 通用 "系统通知" fallback 文案命中——用户至少能感知"有事发生"而不是空白
    expect(screen.getByText(/系统通知/)).toBeTruthy()
  })

  describe('执行限制类通知「去设置」按钮', () => {
    const SPACE_ID = 'space-exec-limits'

    afterEach(() => {
      useAgentSettingsSheetStore.getState().close()
    })

    it('credits_exceeded + spaceId → 渲染按钮，点击打开「执行限制」面板', () => {
      seedSteps([makeNotice('credits_exceeded', '本次运行已达到最大消费上限（credits）而自动停止。', undefined, 'cr-1')])

      render(<SystemNoticeBanner sessionId={SESSION_ID} spaceId={SPACE_ID} />)

      // 运行守卫通知按 warning 档展示（比 info 更醒目）
      const banner = screen.getByTestId('system-notice-banner')
      expect(banner.getAttribute('data-severity')).toBe('warning')

      const button = screen.getByTestId('system-notice-banner-open-limits')
      act(() => {
        fireEvent.click(button)
      })

      const sheet = useAgentSettingsSheetStore.getState()
      expect(sheet.isOpen).toBe(true)
      expect(sheet.section).toBe('execution-limits')
      expect(sheet.spaceId).toBe(SPACE_ID)
    })

    it('tokens_exceeded / force_final 同样渲染按钮', () => {
      seedSteps([
        makeNotice('tokens_exceeded', 'token 预算超限', undefined, 'tk-1'),
        makeNotice('force_final', '运行守卫终止', undefined, 'ff-1'),
      ])
      render(<SystemNoticeBanner sessionId={SESSION_ID} spaceId={SPACE_ID} />)
      expect(screen.getAllByTestId('system-notice-banner-open-limits')).toHaveLength(2)
    })

    it('缺 spaceId → 不渲染按钮（文案仍展示）', () => {
      seedSteps([makeNotice('credits_exceeded', '已达消费上限', undefined, 'cr-2')])
      render(<SystemNoticeBanner sessionId={SESSION_ID} />)
      expect(screen.getByText('已达消费上限')).toBeTruthy()
      expect(screen.queryByTestId('system-notice-banner-open-limits')).toBeNull()
    })

    it('非执行限制类通知（即便有 spaceId）→ 不渲染按钮', () => {
      seedSteps([makeNotice('context_truncated', '上下文已压缩', undefined, 'ct-1')])
      render(<SystemNoticeBanner sessionId={SESSION_ID} spaceId={SPACE_ID} />)
      expect(screen.queryByTestId('system-notice-banner-open-limits')).toBeNull()
    })
  })

  it('detail 与 title 不同时展示双行，相同时仅展示 title', () => {
    seedSteps([
      makeNotice('tool_timeout', '工具超时短标题', '工具「bash」执行超时（约 60s）', 'detail-1'),
      makeNotice('model_fallback', '已切换到备用模型', '已切换到备用模型', 'detail-2'),
    ])
    render(<SystemNoticeBanner sessionId={SESSION_ID} />)
    expect(screen.getByText('工具超时短标题')).toBeTruthy()
    expect(screen.getByText('工具「bash」执行超时（约 60s）')).toBeTruthy()
    // detail === title 时 detail 不重复展示（getAllByText 应只命中 1 个）
    expect(screen.getAllByText('已切换到备用模型')).toHaveLength(1)
  })
})
