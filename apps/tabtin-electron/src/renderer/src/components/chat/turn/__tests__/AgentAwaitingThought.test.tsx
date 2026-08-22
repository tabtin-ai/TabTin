import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentAwaitingThought } from '../AgentAwaitingThought'
import { STREAMING_PREVIEW_HEIGHT_PX } from '../../markdown/streamingPreviewHeight'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

describe('AgentAwaitingThought', () => {
  it('renders 思考中 shell with fixed preview height', () => {
    render(<AgentAwaitingThought />)
    const root = screen.getByTestId('agent-awaiting-thought')
    expect(root.getAttribute('aria-busy')).toBe('true')
    expect(root.getAttribute('data-mode')).toBe('thinking')
    expect(root.textContent).toContain('思考中…')
    expect(screen.queryByTestId('shiny-text')).toBeNull()
    expect(screen.getByTestId('agent-awaiting-thought-preview').style.height).toBe(
      `${STREAMING_PREVIEW_HEIGHT_PX}px`,
    )
    expect(screen.queryByTestId('agent-streaming-tail')).toBeNull()
  })

  it('thinking 模式为三段同色系骨架（chat-motion-awaiting-line，宽 64/82/47%）', () => {
    render(<AgentAwaitingThought mode="thinking" />)
    const preview = screen.getByTestId('agent-awaiting-thought-preview')
    const lines = preview.querySelectorAll('.chat-motion-awaiting-line')
    expect(lines).toHaveLength(3)
    expect(lines[0].className).toContain('w-[64%]')
    expect(lines[1].className).toContain('w-[82%]')
    expect(lines[2].className).toContain('w-[47%]')
    // 同色系：不再用异色残字
    const colors = Array.from(lines).map((el) => el.className.match(/bg-muted\/\d+/)?.[0])
    expect(new Set(colors).size).toBe(1)
    expect(colors[0]).toBe('bg-muted/60')
  })

  it('renders planningNext with same Brain row and no preview skeleton', () => {
    render(<AgentAwaitingThought mode="planningNext" />)
    const root = screen.getByTestId('agent-awaiting-thought')
    expect(root.getAttribute('data-mode')).toBe('planningNext')
    expect(root.textContent).toContain('正在计划下一步...')
    expect(screen.getByTestId('shiny-text')).toBeTruthy()
    expect(screen.queryByTestId('agent-awaiting-thought-preview')).toBeNull()
  })
})
