import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { MediaImageInlineCard } from '../MediaImageInlineCard'
import { clearMediaImageShownForTests, wasMediaImageShown } from '../mediaImageInlineShown'

let sessionBlocksRecord: Record<string, Array<{ block: Record<string, unknown> }>> = {}

vi.mock('@stores/chat/messages/messageBlocks', () => ({
  useSessionBlocksRecord: () => sessionBlocksRecord,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('../../richContent/RichImage', () => ({
  RichImage: ({ block }: { block: { url?: string } }) => (
    <div data-testid="mock-rich-image">{block.url}</div>
  ),
}))

describe('MediaImageInlineCard', () => {
  beforeEach(() => {
    clearMediaImageShownForTests()
    sessionBlocksRecord = {}
  })
  afterEach(() => {
    clearMediaImageShownForTests()
  })

  it('running 无 URL → 画布等待态，无终端', () => {
    render(
      <MediaImageInlineCard
        phase="running"
        command='tabtin media image generate --prompt "apple"'
        sessionId="s1"
      />,
    )
    expect(screen.getByTestId('media-image-inline-card').getAttribute('data-state')).toBe('running')
    expect(screen.getByTestId('image-generating-card')).toBeTruthy()
    expect(screen.queryByTestId('mock-rich-image')).toBeNull()
  })

  it('output 含 result_urls → 原地 RichImage 并 mark 去重', () => {
    const url = 'https://example.com/a.png'
    render(
      <MediaImageInlineCard
        phase="end"
        command='tabtin media image generate --prompt "apple"'
        output={{ stdout: JSON.stringify({ ok: true, data: { result_urls: [url] } }), exit_code: 0 }}
        sessionId="s1"
        messageId="m1"
      />,
    )
    expect(screen.getByTestId('mock-rich-image').textContent).toBe(url)
    expect(wasMediaImageShown('s1', url)).toBe(true)
  })

  it('stored_files 已到但正式消息尚未出现时继续展示预览，避免白屏', () => {
    render(
      <MediaImageInlineCard
        phase="end"
        command='tabtin media image generate --prompt "apple"'
        output={{
          stdout: JSON.stringify({
            ok: true,
            data: {
              status: 'succeeded',
              storage_status: 'succeeded',
              stored_files: [{
                file_id: 'file-123',
                file_name: 'apple.png',
                mime_type: 'image/png',
                file_size: 1024,
                access_url: 'https://oss.example.test/apple.png',
              }],
              stored_urls: ['https://oss.example.test/apple.png'],
            },
          }),
          exit_code: 0,
        }}
        sessionId="s1"
        sourceToolUseId="tool-use-1"
      />,
    )

    expect(screen.getByTestId('mock-rich-image').textContent).toBe('https://oss.example.test/apple.png')
  })

  it('观察到同一 tool_use 的正式图片后才隐藏 CLI 内联图', () => {
    sessionBlocksRecord = {
      formal: [{
        block: {
          type: 'tabtin_rich_content',
          kind: 'image',
          payload: {
            artifact_kind: 'oss_file',
            source_tool_use_id: 'tool-use-1',
            file_id: 'file-123',
          },
        },
      }],
    }
    render(
      <MediaImageInlineCard
        phase="end"
        output={{ result_urls: ['https://provider.example/apple.png'] }}
        sessionId="s1"
        sourceToolUseId="tool-use-1"
      />,
    )

    expect(screen.queryByTestId('media-image-inline-card')).toBeNull()
  })

  it('end 无 URL → 失败态', () => {
    render(
      <MediaImageInlineCard
        phase="end"
        command='tabtin media image generate --prompt "apple"'
        output={{ stdout: 'nope', exit_code: 0 }}
        sessionId="s1"
      />,
    )
    expect(screen.getByTestId('media-image-inline-card').getAttribute('data-state')).toBe('failed')
    expect(screen.getByText('生成失败')).toBeTruthy()
  })

  it('#7381：phase=end 但 output 为 status:running → 保持等待态，不误显失败', () => {
    render(
      <MediaImageInlineCard
        phase="end"
        command='tabtin media image generate --prompt "闹钟"'
        output={{
          status: 'running',
          session_id: 'agent-sess-1',
          pid: 56734,
          stdout_tail: '⏳ 任务已提交: af612e83，等待完成...\n',
          output_file: '/tmp/wesr.log',
        }}
        sessionId="s1"
      />,
    )
    expect(screen.getByTestId('media-image-inline-card').getAttribute('data-state')).toBe('running')
    expect(screen.getByText('正在生成图片')).toBeTruthy()
    expect(screen.queryByText('生成失败')).toBeNull()
  })

  it('#7381：succeeded 但 result_urls 空 → 失败态', () => {
    render(
      <MediaImageInlineCard
        phase="end"
        command='tabtin media image generate --prompt "apple"'
        output={{
          stdout: JSON.stringify({
            ok: true,
            data: { status: 'succeeded', result_urls: [], stored_urls: [] },
          }),
          exit_code: 0,
        }}
        sessionId="s1"
      />,
    )
    expect(screen.getByTestId('media-image-inline-card').getAttribute('data-state')).toBe('failed')
  })

  it('失败态点「查看详情」始终有内容（含空 output）', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(
      <MediaImageInlineCard
        phase="error"
        command='tabtin media image generate --prompt "apple"'
        sessionId="s1"
      />,
    )
    fireEvent.click(screen.getByTestId('media-image-inline-toggle-details'))
    const details = screen.getByTestId('media-image-inline-details')
    expect(details.textContent).toContain('tabtin media image generate')
    expect(details.textContent).toContain('未能解析图片 URL')
  })

  it('失败态点「查看详情」展示 stderr', async () => {
    const { fireEvent } = await import('@testing-library/react')
    render(
      <MediaImageInlineCard
        phase="error"
        command='tabtin media image generate --prompt "apple"'
        output={{ stderr: 'Seedream timed out', exit_code: 1 }}
        sessionId="s1"
      />,
    )
    fireEvent.click(screen.getByTestId('media-image-inline-toggle-details'))
    expect(screen.getByTestId('media-image-inline-details').textContent).toContain('Seedream timed out')
  })
})
