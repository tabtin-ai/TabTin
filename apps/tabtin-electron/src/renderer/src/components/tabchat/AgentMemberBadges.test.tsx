import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentMemberBadges } from './AgentMemberBadges'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; defaultValue?: string }) => {
      if (options?.defaultValue && options.name) {
        return options.defaultValue.replace('{{name}}', options.name)
      }
      return options?.defaultValue ?? key
    },
  }),
}))

vi.mock('@components/ui', () => ({
  Badge: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { variant?: string }) => <div {...props}>{children}</div>,
}))

describe('AgentMemberBadges', () => {
  it('renders a robot icon and owner Badge', () => {
    const { rerender } = render(<AgentMemberBadges ownerName="  张三  " />)
    expect(screen.getByLabelText('AI')).toBeTruthy()
    expect(screen.queryByText('AI')).toBeNull()
    const ownerBadge = screen.getByText('张三')
    expect(ownerBadge.getAttribute('variant')).toBe('default')
    expect(screen.getByLabelText('所属用户 张三')).toBeTruthy()

    rerender(<AgentMemberBadges ownerName="   " />)
    expect(screen.getByLabelText('AI')).toBeTruthy()
    expect(screen.queryByText('张三')).toBeNull()
  })

  it('renders an offline badge when the execution device is offline', () => {
    render(<AgentMemberBadges ownerName="张三" offline />)
    expect(screen.getByText('离线')).toBeTruthy()
    expect(screen.getByLabelText('离线')).toBeTruthy()
  })
})
