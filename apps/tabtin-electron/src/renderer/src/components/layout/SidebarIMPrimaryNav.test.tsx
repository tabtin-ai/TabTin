import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key,
  }),
}))

import { SidebarIMPrimaryNav } from './SidebarIMPrimaryNav'

describe('SidebarIMPrimaryNav', () => {
  it('renders vertical primary-nav rows and dispatches actions', () => {
    const onToggleContacts = vi.fn()
    const onCreateGroup = vi.fn()

    render(
      <SidebarIMPrimaryNav
        isContactsActive
        onToggleContacts={onToggleContacts}
        onCreateGroup={onCreateGroup}
      />,
    )

    expect(screen.getByTestId('sidebar-im-create-group-button').className).toContain('px-1.5')
    expect(screen.getByTestId('sidebar-im-create-group-button').className).toContain('mx-1.5')
    expect(screen.getByTestId('sidebar-im-contacts-button').getAttribute('aria-current')).toBe('page')
    expect(screen.getByTestId('sidebar-im-contacts-button').className).toContain('bg-foreground/[0.06]')

    fireEvent.click(screen.getByTestId('sidebar-im-create-group-button'))
    expect(onCreateGroup).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('sidebar-im-contacts-button'))
    expect(onToggleContacts).toHaveBeenCalledTimes(1)
  })

  it('disables create group when organization is unavailable', () => {
    render(
      <SidebarIMPrimaryNav
        isContactsActive={false}
        createGroupDisabled
        onToggleContacts={vi.fn()}
        onCreateGroup={vi.fn()}
      />,
    )

    expect(screen.getByTestId('sidebar-im-create-group-button').hasAttribute('disabled')).toBe(true)
  })
})
