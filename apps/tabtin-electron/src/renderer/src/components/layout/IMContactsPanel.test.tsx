import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@components/tabchat/ContactsList', () => ({
  ContactsList: ({ layout }: { layout?: string }) => (
    <div data-testid="contacts-list" data-layout={layout ?? 'default'} />
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: unknown) => unknown) => selector({
    selectedOrganization: { id: 'org-1', name: 'tuandui' },
  }),
}))

import { IMContactsPanel } from './IMContactsPanel'

describe('IMContactsPanel', () => {
  it('uses StandaloneModulePage shell aligned with automation/skills modules', () => {
    render(<IMContactsPanel />)

    expect(screen.getByTestId('im-contacts-panel')).toBeTruthy()
    expect(screen.getByText('通讯录')).toBeTruthy()
    expect(screen.getByText('tuandui')).toBeTruthy()
    expect(screen.getByTestId('contacts-list').getAttribute('data-layout')).toBe('module')
    expect(screen.queryByRole('button', { name: '返回消息' })).toBeNull()
  })
})
