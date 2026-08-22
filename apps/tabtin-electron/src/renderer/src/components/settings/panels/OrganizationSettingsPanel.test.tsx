import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Organization } from '@tabtin/app-shell'

const updateOrganization = vi.fn()
const registerDirtyChecker = vi.fn(() => () => {})

vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: unknown) => unknown) =>
    selector({
      updateOrganization,
      deleteOrganization: vi.fn(),
      leaveOrganization: vi.fn(),
      transferOwnership: vi.fn(),
      loadOrganizations: vi.fn(),
      loadMembers: vi.fn(),
      members: [],
      isLoadingMembers: false,
      isMutating: false,
      isLoading: false,
      currentUserRole: 'owner',
    }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: Object.assign(
    (selector: (s: { setRoute: () => void }) => unknown) =>
      selector({ setRoute: vi.fn() }),
    {
      getState: () => ({ registerDirtyChecker }),
    },
  ),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'owner-1' } }),
}))

vi.mock('@/hooks/queries/membership', () => ({
  useCashWalletQuery: () => ({ data: null, isLoading: false, isError: false }),
}))

vi.mock('@components/ui', async () => {
  const actual = await vi.importActual<typeof import('@components/ui')>('@components/ui')
  return {
    ...actual,
    toast: vi.fn(),
  }
})

vi.mock('./OrganizationAvatarUploader', async () => {
  const actual = await vi.importActual<typeof import('./OrganizationAvatarUploader')>(
    './OrganizationAvatarUploader',
  )
  return {
    ...actual,
    OrganizationAvatarUploader: ({
      currentLogo,
      onLogoUploaded,
      onLogoRemoved,
    }: {
      currentLogo?: string
      onLogoUploaded: (url: string) => void
      onLogoRemoved: () => void
    }) => (
      <div>
        <span data-testid="org-logo-preview">{currentLogo ?? ''}</span>
        <button
          type="button"
          data-testid="org-logo-upload"
          onClick={() => onLogoUploaded('https://cdn.example.com/draft-logo.png')}
        >
          mock upload
        </button>
        <button type="button" data-testid="org-logo-remove" onClick={() => onLogoRemoved()}>
          mock remove
        </button>
      </div>
    ),
  }
})

vi.mock('./OrganizationOwnershipTransferDialog', () => ({
  OrganizationOwnershipTransferDialog: () => null,
}))

import { OrganizationSettingsPanel } from './OrganizationSettingsPanel'

const baseOrganization: Organization = {
  id: 'org-1',
  name: 'Acme',
  description: 'Team desc',
  type: 'team',
  owner_id: 'owner-1',
  is_default: false,
  settings: {
    allow_member_yolo: false,
    logo_url: 'https://cdn.example.com/old-logo.png',
  },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

describe('OrganizationSettingsPanel avatar ', () => {
  beforeEach(() => {
    updateOrganization.mockReset()
    updateOrganization.mockResolvedValue(baseOrganization)
    registerDirtyChecker.mockClear()
  })

  it('shows saved logo in read-only profile card', () => {
    const { container } = render(
      <OrganizationSettingsPanel organization={baseOrganization} embedded />,
    )
    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/old-logo.png')
  })

  it('keeps cropped logo as draft until save, then writes settings.logo_url', async () => {
    render(<OrganizationSettingsPanel organization={baseOrganization} embedded />)

    fireEvent.click(screen.getByText('编辑资料'))
    fireEvent.click(screen.getByTestId('org-logo-upload'))

    expect(updateOrganization).not.toHaveBeenCalled()
    expect(screen.getByTestId('org-logo-preview').textContent).toBe(
      'https://cdn.example.com/draft-logo.png',
    )

    fireEvent.click(screen.getByRole('button', { name: 'settings.actions.save' }))

    await waitFor(() => {
      expect(updateOrganization).toHaveBeenCalledWith('org-1', {
        name: 'Acme',
        description: 'Team desc',
        settings: {
          allow_member_yolo: false,
          logo_url: 'https://cdn.example.com/draft-logo.png',
        },
      })
    })
  })

  it('drops logo draft when canceling edit', () => {
    render(<OrganizationSettingsPanel organization={baseOrganization} embedded />)

    fireEvent.click(screen.getByText('编辑资料'))
    fireEvent.click(screen.getByTestId('org-logo-upload'))
    expect(screen.getByTestId('org-logo-preview').textContent).toBe(
      'https://cdn.example.com/draft-logo.png',
    )

    fireEvent.click(screen.getByRole('button', { name: 'settings.actions.cancel' }))
    expect(updateOrganization).not.toHaveBeenCalled()
    expect(screen.queryByTestId('org-logo-preview')).toBeNull()
  })
})
