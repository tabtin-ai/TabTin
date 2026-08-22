import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildCreateOrganizationSettings, CreateOrganizationDialog } from './CreateOrganizationDialog'

const organizationState = {
  createOrganization: vi.fn(),
  isLoading: false,
  error: 'Failed to transfer organization ownership',
}

const { getOrganizationCreatePolicy } = vi.hoisted(() => ({
  getOrganizationCreatePolicy: vi.fn().mockResolvedValue({ allowed: true }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof organizationState) => unknown) => selector(organizationState),
}))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: { getState: () => ({ getCurrentFingerprint: () => null }) },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; max?: number }) => (
      key === 'create.errors.limitExceeded'
        ? `You can create up to ${options?.max} organizations. You have reached the limit.`
        : options?.defaultValue ?? key
    ),
  }),
}))

vi.mock('@tabtin/app-shell', () => ({
  OrganizationApiService: {
    getOrganizationCreatePolicy,
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  CreateOrganizationDialog: ({ error }: { error?: string | null }) => (
    error ? <div role="alert">{error}</div> : <div data-testid="create-organization-dialog" />
  ),
}))

vi.mock('@components/settings/panels/OrganizationAvatarUploader', () => ({
  OrganizationAvatarUploader: () => null,
}))

describe('buildCreateOrganizationSettings ', () => {
  it('includes logo_url when provided', () => {
    expect(
      buildCreateOrganizationSettings(undefined, 'https://cdn.example.com/org.png'),
    ).toEqual({
      logo_url: 'https://cdn.example.com/org.png',
    })
  })

  it('keeps existing settings and drops invalid theme', () => {
    expect(
      buildCreateOrganizationSettings(
        { language: 'zh-CN', theme: 'neon' },
        'https://cdn.example.com/org.png',
      ),
    ).toEqual({
      language: 'zh-CN',
      logo_url: 'https://cdn.example.com/org.png',
    })
  })

  it('returns undefined when empty', () => {
    expect(buildCreateOrganizationSettings(undefined, null)).toBeUndefined()
    expect(buildCreateOrganizationSettings(undefined, '   ')).toBeUndefined()
  })
})

describe('CreateOrganizationDialog', () => {
  it('不展示其他组织操作遗留在共享 store 中的错误', async () => {
    render(<CreateOrganizationDialog isOpen onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('create-organization-dialog')).toBeTruthy()
    })
    expect(screen.queryByText('Failed to transfer organization ownership')).toBeNull()
  })

  it('按当前界面语言展示组织数量上限，不透传后端中文文案', async () => {
    getOrganizationCreatePolicy.mockResolvedValueOnce({
      allowed: false,
      current_count: 3,
      max_allowed: 3,
      remaining: 0,
      message: '每个用户最多可创建 3 个组织，当前已达到上限',
    })

    render(<CreateOrganizationDialog isOpen onClose={vi.fn()} />)

    expect(await screen.findByText(
      'You can create up to 3 organizations. You have reached the limit.',
    )).toBeTruthy()
    expect(screen.queryByText(/每个用户最多可创建/)).toBeNull()
  })
})
