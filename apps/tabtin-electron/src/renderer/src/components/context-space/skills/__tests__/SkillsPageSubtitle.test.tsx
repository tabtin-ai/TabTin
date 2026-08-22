import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openAgentHub = vi.hoisted(() => vi.fn())

vi.mock('@/services/agentMemoryNavigation', () => ({
  openAgentHub,
}))

vi.mock('react-i18next', () => ({
  Trans: ({
    components,
  }: {
    components?: { agentHub?: React.ReactElement }
  }) => (
    <span>
      prefix{' '}
      {components?.agentHub
        ? React.cloneElement(components.agentHub, undefined, 'AI 分身')
        : null}{' '}
      suffix
    </span>
  ),
}))

import { SkillsPageSubtitle } from '../SkillsPageSubtitle'

describe('SkillsPageSubtitle', () => {
  beforeEach(() => {
    openAgentHub.mockClear()
  })

  it('opens AI avatar hub when the agentHub link is clicked', () => {
    render(<SkillsPageSubtitle />)
    fireEvent.click(screen.getByRole('button', { name: 'AI 分身' }))
    expect(openAgentHub).toHaveBeenCalledTimes(1)
  })
})
