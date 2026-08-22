/**
 * RequestApprovalPanel — 动效入场 / 风险边框 / 无侧边色条回归。
 */

import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RequestApprovalPanel } from '../RequestApprovalPanel'

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

function classListOf(el: HTMLElement): string {
  return typeof el.className === 'string' ? el.className : String(el.className)
}

describe('RequestApprovalPanel · 动效入场与视觉层级', () => {
  it('review：warning 单边框 + 入场 class，无侧边色条 / ring / pulse / spin', () => {
    render(
      <RequestApprovalPanel
        rationale="写入表格"
        riskLevel="review"
        onApprovalSubmit={vi.fn()}
      />,
    )

    const panel = screen.getByTestId('request-approval-panel')
    const classes = classListOf(panel)
    expect(classes).toContain('chat-motion-approval-enter')
    expect(classes).toContain('border-warning/40')
    expect(classes.includes('ring-1')).toBe(false)
    expect(classes.includes('ring-warning')).toBe(false)
    expect(classes.includes('animate-pulse')).toBe(false)
    expect(classes.includes('animate-spin')).toBe(false)

    expect(screen.queryByTestId('approval-severity-bar')).toBeNull()
  })

  it('high：destructive 单边框，无侧边色条 / ring 双描边', () => {
    render(
      <RequestApprovalPanel
        rationale="删除外部数据"
        riskLevel="high"
        onApprovalSubmit={vi.fn()}
      />,
    )

    const panel = screen.getByTestId('request-approval-panel')
    const classes = classListOf(panel)
    expect(classes).toContain('border-destructive/60')
    expect(classes.includes('ring-1')).toBe(false)
    expect(classes.includes('ring-destructive')).toBe(false)
    expect(classes).toContain('chat-motion-approval-enter')

    expect(screen.queryByTestId('approval-severity-bar')).toBeNull()
  })

  it('safe：保留入场 class，不渲染侧边色条', () => {
    render(
      <RequestApprovalPanel
        rationale="只读确认"
        riskLevel="safe"
        onApprovalSubmit={vi.fn()}
      />,
    )

    const panel = screen.getByTestId('request-approval-panel')
    const classes = classListOf(panel)
    expect(classes).toContain('chat-motion-approval-enter')
    expect(screen.queryByTestId('approval-severity-bar')).toBeNull()
    expect(classes.includes('animate-pulse')).toBe(false)
    expect(classes.includes('animate-spin')).toBe(false)
  })
})
