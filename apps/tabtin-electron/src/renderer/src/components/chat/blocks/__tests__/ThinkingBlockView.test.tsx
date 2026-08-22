import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { ThinkingBlockView } from '../ThinkingBlockView'
import type { ContentBlockEntry } from '../types'
import {
  TurnEndLayoutProvider,
  IDLE_TURN_END_LAYOUT,
  type TurnEndLayoutValue,
} from '../../viewport/TurnEndLayoutContext'
import type { TurnEndLayoutPhase } from '../../viewport/turnEndLayoutPhase'

vi.mock('../../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-markdown">{content}</div>
  ),
}))

function makeThinking(
  text: string,
  finalized = true,
  extra: Partial<ContentBlockEntry> = {},
): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'think-1',
    block: { type: 'thinking', thinking: text, signature: 'sig-abc' },
    finalized,
    partial: false,
    ...extra,
  }
}

function makeRedacted(): ContentBlockEntry {
  return {
    index: 0,
    block_id: 'redact-1',
    block: { type: 'redacted_thinking', data: 'base64enc==' },
    finalized: true,
    partial: false,
  }
}

/** 真实 Provider value 形状；只改 phase/hold flags，不 mock hook。 */
function turnEndValue(phase: TurnEndLayoutPhase): TurnEndLayoutValue {
  const hold = phase === 'committing' || phase === 'settling'
  return {
    ...IDLE_TURN_END_LAYOUT,
    phase,
    shouldHoldThinkingPreviewBudget: hold,
    shouldHoldClosingSpacer: hold && !IDLE_TURN_END_LAYOUT.closingUiReady,
  }
}

function previewBudgetEl(): HTMLElement | null {
  return (
    screen.queryByTestId('thinking-preview-collapsing')
    ?? screen.queryByTestId('thinking-streaming-preview')
  )
}

function withTurnEnd(
  phase: TurnEndLayoutPhase,
  entry: ContentBlockEntry,
  ui?: React.ReactElement,
) {
  return (
    <TurnEndLayoutProvider value={turnEndValue(phase)}>
      {ui ?? (
        <ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />
      )}
    </TurnEndLayoutProvider>
  )
}

describe('ThinkingBlockView', () => {
  it('happy: finalized thinking shows "Thought" collapsed label', () => {
    render(<ThinkingBlockView entry={makeThinking('I should read the file')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-thinking')).toBeTruthy()
    expect(screen.getByText('blockTimeline.thinking.thought')).toBeTruthy()
  })

  it('happy: click expands to show full markdown content', () => {
    render(<ThinkingBlockView entry={makeThinking('Deep thought content')} sessionId="s1" messageId="m1" />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('mock-markdown').textContent).toBe('Deep thought content')
  })

  it('streaming: non-finalized shows STEP_ROW fold line with shiny label', () => {
    render(<ThinkingBlockView entry={makeThinking('some partial thinking text here', false)} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-thinking-streaming')).toBeTruthy()
    const row = screen.getByRole('button')
    expect(row.classList.contains('pl-0')).toBe(true)
    expect(row.classList.contains('px-2')).toBe(false)
    expect(screen.getByTestId('shiny-text')).toBeTruthy()
    expect(screen.queryByTestId('thinking-token-count')).toBeNull()
    expect(screen.queryByTestId('thinking-pulse')).toBeNull()
  })

  // 流式预览：thinking 文本默认实时可见，不需要用户点击
  it('streaming: preview text is visible by default without clicking', () => {
    render(<ThinkingBlockView entry={makeThinking('live streaming thought', false)} sessionId="s1" messageId="m1" />)
    const preview = screen.getByTestId('thinking-streaming-preview')
    expect(preview.textContent).toContain('live streaming thought')
    // 纯文本，不走 Markdown
    expect(screen.queryByTestId('mock-markdown')).toBeNull()
  })

  // 空 thinking 块让位给 AgentAwaitingThought，避免与「计划下一步 / 思考中」空壳打架。
  it('streaming: empty thinking text renders nothing (shell owns the gap)', () => {
    const { container } = render(
      <ThinkingBlockView entry={makeThinking('', false)} sessionId="s1" messageId="m1" />,
    )
    expect(screen.queryByTestId('block-thinking-streaming')).toBeNull()
    expect(screen.queryByTestId('thinking-streaming-preview')).toBeNull()
    expect(container.textContent).toBe('')
  })

  // 弹跳防线：预览容器从出现起就固定高度，虚拟列表行高一次稳定。
  it('streaming: preview window has fixed height once text arrives', () => {
    const { rerender } = render(
      <ThinkingBlockView entry={makeThinking('hi', false)} sessionId="s1" messageId="m1" />,
    )
    const preview = screen.getByTestId('thinking-streaming-preview')
    expect(preview.style.height).toBe('66px')
    // 文本增长后高度不变
    rerender(
      <ThinkingBlockView
        entry={makeThinking('a much longer piece of streaming thinking text that grows over time', false)}
        sessionId="s1"
        messageId="m1"
      />,
    )
    expect(screen.getByTestId('thinking-streaming-preview').style.height).toBe('66px')
  })

  it('streaming: click toggles between full raw text and fixed-height preview', () => {
    render(<ThinkingBlockView entry={makeThinking('raw thinking', false)} sessionId="s1" messageId="m1" />)
    // 展开全文：无高度上限、仍是纯文本
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('thinking-streaming-preview')).toBeNull()
    expect(screen.getByTestId('thinking-streaming-full').textContent).toContain('raw thinking')
    expect(screen.queryByTestId('mock-markdown')).toBeNull()
    // 再点收回预览
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByTestId('thinking-streaming-preview')).toBeTruthy()
    expect(screen.queryByTestId('thinking-streaming-full')).toBeNull()
  })

  // suppressInlineLoading：会话级等待壳可见时不显示 inline Loader2，
  // 但预览窗口照常显示（默认流式展示不受影响）。
  it('streaming: suppressInlineLoading hides Loader2 but keeps the preview window', () => {
    const { container } = render(
      <ThinkingBlockView
        entry={makeThinking('quiet streaming', false)}
        sessionId="s1"
        messageId="m1"
        suppressInlineLoading
      />,
    )
    const preview = screen.getByTestId('thinking-streaming-preview')
    expect(preview.textContent).toContain('quiet streaming')
    expect(container.querySelector('.animate-spin')).toBeNull()
  })

  it('streaming: without suppressInlineLoading the inline Loader2 spinner shows', () => {
    const { container } = render(
      <ThinkingBlockView entry={makeThinking('loud streaming', false)} sessionId="s1" messageId="m1" />,
    )
    expect(container.querySelector('.animate-spin')).toBeTruthy()
  })

  // 流式标签用 ShinyText 扫光，不再显示 token 计数。
  describe('streaming shiny label（无 token 计数）', () => {
    it('streaming: shiny-text 可见，无 thinking-token-count', () => {
      render(<ThinkingBlockView entry={makeThinking('some partial thinking text here', false)} sessionId="s1" messageId="m1" />)
      expect(screen.getByTestId('shiny-text')).toBeTruthy()
      expect(screen.queryByTestId('thinking-token-count')).toBeNull()
    })

    it('streaming: 空文本不渲染整行（shell 承接）', () => {
      render(<ThinkingBlockView entry={makeThinking('', false)} sessionId="s1" messageId="m1" />)
      expect(screen.queryByTestId('shiny-text')).toBeNull()
      expect(screen.queryByTestId('thinking-token-count')).toBeNull()
    })
  })

  // 平滑流式揭示（typewriter reveal）：chunk 到达不整块闪出，摊到后续帧逐字揭示
  describe('typewriter 平滑揭示', () => {
    it('streaming: 挂载瞬间对齐当前全量文本（不重播老文本）', () => {
      render(<ThinkingBlockView entry={makeThinking('already streamed text', false)} sessionId="s1" messageId="m1" />)
      expect(screen.getByTestId('thinking-streaming-preview').textContent).toContain('already streamed text')
    })

    it('streaming: 追加的 chunk 不整块闪出，经 rAF 逐帧揭示后收敛到全量', async () => {
      const { rerender } = render(
        <ThinkingBlockView entry={makeThinking('prefix ', false)} sessionId="s1" messageId="m1" />,
      )
      rerender(
        <ThinkingBlockView
          entry={makeThinking('prefix and a newly arrived chunk of thinking text', false)}
          sessionId="s1"
          messageId="m1"
        />,
      )
      // rerender 同步后追加尾部尚未揭示（rAF 还没跑）——这就是「不闪出」
      const preview = screen.getByTestId('thinking-streaming-preview')
      expect(preview.textContent).not.toContain('chunk of thinking text')
      expect(preview.textContent).toContain('prefix')
      // rAF 逐帧揭示后收敛到全量
      await waitFor(
        () => expect(
          screen.getByTestId('thinking-streaming-preview').textContent,
        ).toContain('prefix and a newly arrived chunk of thinking text'),
        { timeout: 3000 },
      )
    })

    it('finalize 后展开显示全量文本（不受揭示进度影响）', () => {
      const { rerender } = render(
        <ThinkingBlockView
          entry={makeThinking('start ', false, { block_id: 'think-typewriter-finalize' })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      rerender(
        <ThinkingBlockView
          entry={makeThinking('start and then it finished abruptly', true, {
            block_id: 'think-typewriter-finalize',
            startedAt: 1_000_000,
            stoppedAt: 1_002_000,
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByTestId('mock-markdown').textContent).toBe('start and then it finished abruptly')
    })
  })

  it('redacted: shows lock icon and "Reasoning encrypted"', () => {
    render(<ThinkingBlockView entry={makeRedacted()} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-redacted-thinking')).toBeTruthy()
    expect(screen.getByText('blockTimeline.thinking.redacted')).toBeTruthy()
  })

  it('fallback: empty thinking string renders without crashing', () => {
    render(<ThinkingBlockView entry={makeThinking('')} sessionId="s1" messageId="m1" />)
    expect(screen.getByTestId('block-thinking')).toBeTruthy()
  })

  it('layout: collapsed thinking row left-aligns with text and cards', () => {
    render(<ThinkingBlockView entry={makeThinking('I should read the file')} sessionId="s1" messageId="m1" />)
    const row = screen.getByRole('button')
    expect(row.classList.contains('pl-0')).toBe(true)
    expect(row.classList.contains('pr-2')).toBe(true)
    expect(row.classList.contains('px-2')).toBe(false)
  })

  // W4c · W4b-P1-1：finalized 后显示 "Thought for Xs" 秒数
  describe('W4c · W4b-P1-1 "Thought for Xs" 秒数显示', () => {
    it('startedAt + stoppedAt 都存在且 ≥1s 时显示整数秒', () => {
      const entry = makeThinking('done thinking', true, {
        startedAt: 1_000_000,
        stoppedAt: 1_005_000, // 5s
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      // i18n key + interpolation defaultValue 形如 "Thought for 5s"
      expect(screen.getByText(/blockTimeline\.thinking\.thoughtForSeconds/)).toBeTruthy()
    })

    it('耗时 <1s 时不显示秒数，走「已思考」不带秒数分支', () => {
      const entry = makeThinking('quick thought', true, {
        startedAt: 1_000_000,
        stoppedAt: 1_000_500, // 500ms
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      // <1s 走 thought 分支（「已思考」），不显示秒数
      expect(screen.getByText('blockTimeline.thinking.thought')).toBeTruthy()
      expect(screen.queryByText(/blockTimeline\.thinking\.thoughtForSeconds/)).toBeNull()
    })

    it('startedAt 缺失时 fallback 到 "Thought" 单词不显示秒数', () => {
      const entry = makeThinking('orphan thought', true, {
        // 无 startedAt
        stoppedAt: 1_000_500,
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.getByText('blockTimeline.thinking.thought')).toBeTruthy()
    })

    it('stoppedAt 缺失时 fallback 到 "Thought" 单词', () => {
      const entry = makeThinking('orphan thought 2', true, {
        startedAt: 1_000_000,
        // 无 stoppedAt
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.getByText('blockTimeline.thinking.thought')).toBeTruthy()
    })

    it('stoppedAt < startedAt（数据异常）时不显示秒数（不显示 NaN）', () => {
      const entry = makeThinking('weird timestamps', true, {
        startedAt: 2_000_000,
        stoppedAt: 1_000_000, // 倒退
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.getByText('blockTimeline.thinking.thought')).toBeTruthy()
    })
  })

  // W4c · W4a-L12：partial=true 时显示 partialReason 文案区分
  describe('W4c · W4a-L12 partialReason 文案', () => {
    it('partial=true + partialReason="aborted" 显示"已中断"', () => {
      const entry = makeThinking('interrupted thought', true, {
        partial: true,
        partialReason: 'aborted',
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.getByText('blockTimeline.partial.aborted')).toBeTruthy()
    })

    it('partial=true + partialReason="stream_interrupted" 显示"等待响应超时"', () => {
      const entry = makeThinking('timeout thought', true, {
        partial: true,
        partialReason: 'stream_interrupted',
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.getByText('blockTimeline.partial.streamInterrupted')).toBeTruthy()
    })

    it('partial=true + partialReason undefined 显示"…内容被截断"兜底文案', () => {
      const entry = makeThinking('truncated thought', true, {
        partial: true,
      })
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.getByText('blockTimeline.text.truncated')).toBeTruthy()
    })

    it('partial=false 不显示 partial 文案', () => {
      const entry = makeThinking('normal thought', true)
      render(<ThinkingBlockView entry={entry} sessionId="s1" messageId="m1" />)
      expect(screen.queryByText('blockTimeline.partial.aborted')).toBeNull()
      expect(screen.queryByText('blockTimeline.partial.streamInterrupted')).toBeNull()
      expect(screen.queryByText('blockTimeline.text.truncated')).toBeNull()
    })
  })

  // 流式 → finalized：自动折叠回「Thought for Xs」一行
  describe('finalized 后自动折叠', () => {
    it('finalize 后流式预览消失，只剩折叠行；塌缩占位过渡后卸载', async () => {
      const { rerender } = render(
        <ThinkingBlockView
          entry={makeThinking('streaming then done', false, {
            block_id: 'think-finalize-collapse',
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('thinking-streaming-preview')).toBeTruthy()

      rerender(
        <ThinkingBlockView
          entry={makeThinking('streaming then done', true, {
            block_id: 'think-finalize-collapse',
            startedAt: 1_000_000,
            stoppedAt: 1_004_000,
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      // 自动折叠：流式预览消失，「Thought for Xs」折叠行出现（无需点击）
      expect(screen.queryByTestId('thinking-streaming-preview')).toBeNull()
      expect(screen.getByTestId('block-thinking')).toBeTruthy()
      expect(screen.getByText(/blockTimeline\.thinking\.thoughtForSeconds/)).toBeTruthy()
      // 塌缩占位（缓解行高一次性跳变）短暂存在，过渡结束后卸载不留占位
      expect(screen.getByTestId('thinking-preview-collapsing')).toBeTruthy()
      await waitFor(
        () => expect(screen.queryByTestId('thinking-preview-collapsing')).toBeNull(),
        { timeout: 1000 },
      )
    })

    it('thinking 完成后即使回答仍在流式，也会卸载思考预览', async () => {
      vi.useFakeTimers()
      try {
        const { rerender } = render(
          <ThinkingBlockView
            entry={makeThinking('thinking before answer', false, {
              block_id: 'think-finalize-while-answering',
            })}
            sessionId="s1"
            messageId="m1"
            isStreaming
            isLastAssistantMsg
          />,
        )

        rerender(
          <ThinkingBlockView
            entry={makeThinking('thinking before answer', true, {
              block_id: 'think-finalize-while-answering',
              startedAt: 1_000_000,
              stoppedAt: 1_002_000,
            })}
            sessionId="s1"
            messageId="m1"
            isStreaming
            isLastAssistantMsg
          />,
        )

        await act(async () => {
          vi.advanceTimersByTime(300)
          await Promise.resolve()
        })

        expect(screen.getByTestId('block-thinking')).toBeTruthy()
        expect(screen.queryByTestId('thinking-preview-collapsing')).toBeNull()
        expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false')
        expect(screen.getByTestId('block-thinking').textContent).not.toContain('thinking before answer')
      } finally {
        vi.useRealTimers()
      }
    })

    it('历史消息初次挂载即 finalized：不播塌缩占位动画', () => {
      render(
        <ThinkingBlockView
          entry={makeThinking('historical thought', true, {
            startedAt: 1_000_000,
            stoppedAt: 1_002_000,
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('block-thinking')).toBeTruthy()
      expect(screen.queryByTestId('thinking-preview-collapsing')).toBeNull()
    })
  })

  // W4.5 §服务端 ID 命名空间统一（2026-05-13）：Rules of Hooks regression guard
  //
  // 旧实现把 `thoughtDurationSeconds` 的 `useMemo` 放在 `!entry.finalized`
  // early return 之后——同一个 entry 在流式 false → finalized true 状态切换
  // 时 hooks 数量从 4 变 5，React 抛 "Rendered more hooks than during the
  // previous render"，BlockTimelineItem 的 ErrorBoundary 兜底为
  // FallbackBlockView "render-error · type=thinking"。
  //
  // 本测试用 `rerender` 在同一组件实例上切 `finalized` 值，验证不抛错。
  // 任何未来重构再次把 hook 调用放到 early return 之后都会被这个测试 catch。
  describe('Rules of Hooks regression guard', () => {
    it('finalized=false → finalized=true 状态切换不抛 hooks 顺序错误', () => {
      const { rerender } = render(
        <ThinkingBlockView
          entry={makeThinking('partial thinking', false)}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('block-thinking-streaming')).toBeTruthy()

      // 模拟 daemon 流式 → finalize 过渡：同 block_id / 同 thinking text，
      // 仅 finalized 翻成 true。任意 hook 放在 early return 之后都会让这一步
      // throw "Rendered more hooks than during the previous render"。
      rerender(
        <ThinkingBlockView
          entry={makeThinking('partial thinking', true, {
            startedAt: 1_000_000,
            stoppedAt: 1_003_000,
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('block-thinking')).toBeTruthy()
      expect(screen.queryByTestId('block-thinking-streaming')).toBeNull()
    })

    it('thinking → redacted_thinking 切换（极端 case）不抛 hooks 错误', () => {
      const { rerender } = render(
        <ThinkingBlockView
          entry={makeThinking('text', true)}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('block-thinking')).toBeTruthy()
      rerender(
        <ThinkingBlockView entry={makeRedacted()} sessionId="s1" messageId="m1" />,
      )
      expect(screen.getByTestId('block-redacted-thinking')).toBeTruthy()
    })
  })

  // Phase 2 Task 4：亲历 streaming 的 Thinking 在 turn-end committing/settling
  // 保留 66px 预算；released/idle 后再塌缩卸载。
  describe('turn-end thinking preview budget', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('turn-end settling：finalized 后仍保留 66px 预算直至 released', async () => {
      vi.useFakeTimers()
      const streaming = makeThinking('done thinking after stream', false, {
        block_id: 'think-turn-end-hold',
      })
      const finalized = makeThinking('done thinking after stream', true, {
        block_id: 'think-turn-end-hold',
        startedAt: 1_000_000,
        stoppedAt: 1_003_000,
      })

      const { rerender } = render(withTurnEnd('settling', streaming))
      // 先 streaming 渲染建立 hasEverStreamed
      expect(screen.getByTestId('thinking-streaming-preview')).toBeTruthy()

      rerender(withTurnEnd('settling', finalized))
      // 推进本会触发 66→0 的 rAF + 卸载 timer；hold 期间必须仍是 66px 且不卸载
      await act(async () => {
        vi.advanceTimersByTime(0)
        await Promise.resolve()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      const held = previewBudgetEl()
      expect(held).toBeTruthy()
      expect(held!.style.height).toBe('66px')

      rerender(withTurnEnd('committing', finalized))
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      expect(previewBudgetEl()?.style.height).toBe('66px')

      rerender(withTurnEnd('released', finalized))
      // released 后走现有塌缩；推进 rAF + unmount 后预算消失
      await act(async () => {
        vi.advanceTimersByTime(0)
        await Promise.resolve()
      })
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      expect(previewBudgetEl()).toBeNull()
      vi.useRealTimers()
    })

    it('streamingExpanded 全文态在 turn-end 先回到 66px 预算，不出现全文→0 双阶跃', async () => {
      vi.useFakeTimers()
      const streaming = makeThinking('expanded then finalize', false, {
        block_id: 'think-turn-end-expanded',
      })
      const finalized = makeThinking('expanded then finalize', true, {
        block_id: 'think-turn-end-expanded',
        startedAt: 1_000_000,
        stoppedAt: 1_002_000,
      })

      const { rerender } = render(withTurnEnd('settling', streaming))
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByTestId('thinking-streaming-full')).toBeTruthy()

      rerender(withTurnEnd('settling', finalized))
      expect(screen.queryByTestId('thinking-streaming-full')).toBeNull()
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      const held = previewBudgetEl()
      expect(held).toBeTruthy()
      expect(held!.style.height).toBe('66px')
      vi.useRealTimers()
    })

    it('无 turn-end provider 时保持旧塌缩过渡（向后兼容）', async () => {
      const { rerender } = render(
        <ThinkingBlockView
          entry={makeThinking('streaming then done', false, {
            block_id: 'think-no-provider-collapse',
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('thinking-streaming-preview')).toBeTruthy()

      rerender(
        <ThinkingBlockView
          entry={makeThinking('streaming then done', true, {
            block_id: 'think-no-provider-collapse',
            startedAt: 1_000_000,
            stoppedAt: 1_004_000,
          })}
          sessionId="s1"
          messageId="m1"
        />,
      )
      expect(screen.getByTestId('thinking-preview-collapsing')).toBeTruthy()
      await waitFor(
        () => expect(screen.queryByTestId('thinking-preview-collapsing')).toBeNull(),
        { timeout: 1000 },
      )
    })

    it('历史消息初次 mount 即 finalized：即使 phase=settling 也不播预算/塌缩', () => {
      render(
        withTurnEnd(
          'settling',
          makeThinking('historical thought', true, {
            block_id: 'think-historical-settling',
            startedAt: 1_000_000,
            stoppedAt: 1_002_000,
          }),
        ),
      )
      expect(screen.getByTestId('block-thinking')).toBeTruthy()
      expect(previewBudgetEl()).toBeNull()
    })

    it('用户显式展开不受 hold 影响：expanded 仍渲染 Markdown', () => {
      const streaming = makeThinking('user expands after finalize', false, {
        block_id: 'think-user-expand-hold',
      })
      const finalized = makeThinking('user expands after finalize', true, {
        block_id: 'think-user-expand-hold',
        startedAt: 1_000_000,
        stoppedAt: 1_002_000,
      })

      const { rerender } = render(withTurnEnd('settling', streaming))
      rerender(withTurnEnd('settling', finalized))
      fireEvent.click(screen.getByRole('button'))
      expect(screen.getByTestId('mock-markdown').textContent).toBe('user expands after finalize')
    })
  })
})
