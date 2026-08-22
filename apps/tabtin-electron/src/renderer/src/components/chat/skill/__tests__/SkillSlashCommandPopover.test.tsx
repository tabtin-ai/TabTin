import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { SkillIndexEntry } from '@/skills/types'
import { buildSkillSlashCommandOptions } from '../skillSlashCommand'
import { SkillSlashCommandPopover } from '../SkillSlashCommandPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      if (key === 'skillSlash.emptySearch') return `empty:${vars?.query}`
      return key
    },
  }),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

function skill(overrides: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    skill_id: overrides.skill_id ?? overrides.slug ?? 'skill-1',
    skill_key: overrides.skill_key ?? `user:${overrides.slug ?? 'skill-1'}`,
    slug: overrides.slug,
    name: overrides.name ?? overrides.slug ?? 'Skill One',
    source: overrides.source ?? 'user',
    description: overrides.description,
    installed: overrides.installed ?? true,
    enabled: overrides.enabled,
    agent_enabled: overrides.agent_enabled ?? true,
    display_name: overrides.display_name,
    distribution: overrides.distribution,
    ...overrides,
  }
}

describe('SkillSlashCommandPopover', () => {
  it('keeps the active keyboard option visible', () => {
    const options = buildSkillSlashCommandOptions(
      Array.from({ length: 12 }, (_, index) => skill({
        slug: `skill-${index + 1}`,
        display_name: `Skill ${index + 1}`,
        description: `Description ${index + 1}`,
      })),
    )
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView

    try {
      const { rerender } = render(
        <SkillSlashCommandPopover
          open
          query=""
          options={options}
          activeIndex={0}
          onActiveIndexChange={vi.fn()}
          onSelect={vi.fn()}
        />,
      )

      scrollIntoView.mockClear()
      rerender(
        <SkillSlashCommandPopover
          open
          query=""
          options={options}
          activeIndex={9}
          onActiveIndexChange={vi.fn()}
          onSelect={vi.fn()}
        />,
      )

      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('renders available skill commands and selects clicked item', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'meeting-notes',
        display_name: 'Meeting Notes',
        description: 'Turn meetings into actions',
        source: 'app',
        distribution: 'marketplace',
      }),
    ])
    const onSelect = vi.fn()

    render(
      <SkillSlashCommandPopover
        open
        query=""
        options={options}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onSelect={onSelect}
      />,
    )

    expect(screen.getByTestId('skill-slash-popover')).not.toBeNull()
    expect(screen.getByText('/meeting-notes')).not.toBeNull()
    expect(screen.queryByText('Meeting Notes')).toBeNull()
    expect(screen.getByRole('option').getAttribute('title')).toBeNull()
    expect(screen.getByRole('option').getAttribute('aria-label')).toContain('Meeting Notes')
    expect(screen.getByText('Turn meetings into actions')).not.toBeNull()
    expect(screen.getByRole('option').getAttribute('aria-label')).toContain('Turn meetings into actions')
    expect(screen.getByText('Marketplace')).not.toBeNull()

    fireEvent.click(screen.getByRole('option'))
    expect(onSelect).toHaveBeenCalledWith(options[0])
  })

  it('labels Personal Plugin skill commands with the plugin name', () => {
    const options = buildSkillSlashCommandOptions([
      skill({
        slug: 'systematic-debugging',
        display_name: 'Systematic Debugging',
        description: 'Find root causes before fixing',
        source: 'user',
        meta: {
          personal_plugin_id: 'superpowers',
          personal_plugin_display_name: 'Superpowers',
        },
      }),
    ])

    render(
      <SkillSlashCommandPopover
        open
        query="debug"
        options={options}
        activeIndex={0}
        onActiveIndexChange={vi.fn()}
        onSelect={vi.fn()}
      />,
    )

    expect(screen.getByText('/systematic-debugging')).not.toBeNull()
    expect(screen.getByText('Superpowers')).not.toBeNull()
  })

  it('shows empty search state', () => {
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView

    try {
      render(
        <SkillSlashCommandPopover
          open
          query="none"
          options={[]}
          activeIndex={0}
          onActiveIndexChange={vi.fn()}
          onSelect={vi.fn()}
        />,
      )

      expect(screen.getByText('empty:none')).not.toBeNull()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })

  it('does not render when closed', () => {
    const scrollIntoView = vi.fn()
    const originalScrollIntoView = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView

    try {
      render(
        <SkillSlashCommandPopover
          open={false}
          query=""
          options={[]}
          activeIndex={0}
          onActiveIndexChange={vi.fn()}
          onSelect={vi.fn()}
        />,
      )

      expect(screen.queryByTestId('skill-slash-popover')).toBeNull()
      expect(scrollIntoView).not.toHaveBeenCalled()
    } finally {
      Element.prototype.scrollIntoView = originalScrollIntoView
    }
  })
})
