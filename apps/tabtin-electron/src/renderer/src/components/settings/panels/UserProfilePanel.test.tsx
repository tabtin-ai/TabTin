import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type ButtonMockProps = React.PropsWithChildren<{
  onClick?: React.MouseEventHandler<HTMLButtonElement>
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
}>

type InputMockProps = {
  id?: string
  value?: string
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  placeholder?: string
  className?: string
}

type TextareaMockProps = {
  id?: string
  value?: string
  onChange?: React.ChangeEventHandler<HTMLTextAreaElement>
  placeholder?: string
  rows?: number
  className?: string
}

type HeaderMockProps = {
  title: React.ReactNode
  subtitle?: React.ReactNode
}

type UserAvatarUploaderMockProps = {
  currentAvatar?: string
  onAvatarUploaded: (draft: { url: string; fileId: string }) => void
}

type UserAvatarMockProps = {
  name: string
  className?: string
}

function avatarInitials(name: string): string {
  const words = name.trim().split(/\s+/)
  return words.length > 1
    ? words.slice(0, 2).map((word) => Array.from(word)[0]).join('').toUpperCase()
    : Array.from(name.trim()).slice(0, 2).join('').toUpperCase()
}

const authMock = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  updateProfile: vi.fn(),
  logout: vi.fn(),
  registerDirtyChecker: vi.fn(() => () => {}),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN' },
    t: (key: string, options?: Record<string, unknown>) => {
      if (typeof options?.defaultValue === 'string') return options.defaultValue
      return key
    },
  }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector(authMock.state),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({
      registerDirtyChecker: authMock.registerDirtyChecker,
    }),
  },
}))

vi.mock('@/services/api', () => ({
  default: {
    sendEmailVerification: vi.fn(),
    sendPhoneVerification: vi.fn(),
  },
}))

vi.mock('@tabtin/shared/use-countdown', () => ({
  useCountdown: () => ({
    countdown: 0,
    isRunning: false,
    start: vi.fn(),
    reset: vi.fn(),
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, onClick, disabled, type = 'button' }: ButtonMockProps) => (
    <button type={type} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  ConfirmDialog: () => null,
  Input: ({ id, value, onChange, onKeyDown, placeholder, className }: InputMockProps) => (
    <input
      id={id}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className={className}
    />
  ),
  LoadingSpinner: () => <span data-testid="loading-spinner" />,
  UserAvatar: ({ name, className }: UserAvatarMockProps) => (
    <span title={name} className={`rounded-full ${className ?? ''}`}>{avatarInitials(name) || '?'}</span>
  ),
  Textarea: ({ id, value, onChange, placeholder, rows, className }: TextareaMockProps) => (
    <textarea id={id} value={value} onChange={onChange} placeholder={placeholder} rows={rows} className={className} />
  ),
  toast: vi.fn(),
}))

vi.mock('../SettingsPanelHeader', () => ({
  SettingsPanelHeader: ({ title, subtitle }: HeaderMockProps) => (
    <header>
      <h2>{title}</h2>
      <p>{subtitle}</p>
    </header>
  ),
}))

vi.mock('../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}))

vi.mock('./ChangePasswordDialog', () => ({
  ChangePasswordDialog: () => null,
}))

vi.mock('./UserAvatarUploader', () => ({
  UserAvatarUploader: ({ currentAvatar, onAvatarUploaded }: UserAvatarUploaderMockProps) => (
    <div>
      <span data-testid="avatar-preview">{currentAvatar}</span>
      <button
        type="button"
        data-testid="avatar-upload"
        onClick={() => onAvatarUploaded({ url: 'draft-avatar.png', fileId: 'file-123' })}
      >
        mock upload
      </button>
    </div>
  ),
}))

import { UserProfilePanel } from './UserProfilePanel'

function renderProfilePanel() {
  return render(<UserProfilePanel />)
}

describe('UserProfilePanel avatar draft flow', () => {
  beforeEach(() => {
    authMock.updateProfile.mockReset()
    authMock.updateProfile.mockResolvedValue(undefined)
    authMock.logout.mockReset()
    authMock.registerDirtyChecker.mockClear()
    authMock.state = {
      user: {
        id: 'user-1',
        nickname: 'Alice',
        username: 'alice',
        bio: 'hello',
        avatar: 'old-avatar.png',
        email: 'alice@example.com',
        phone: '13800138000',
        is_verified_email: true,
        is_verified_phone: true,
        date_joined: '2026-01-01T00:00:00Z',
        login_count: 3,
        last_login: null,
      },
      updateProfile: authMock.updateProfile,
      logout: authMock.logout,
      isLoading: false,
    }
  })

  it('keeps cropped avatar as a draft until profile save', () => {
    renderProfilePanel()

    fireEvent.click(screen.getByText('actions.editProfile'))
    fireEvent.click(screen.getByTestId('avatar-upload'))

    expect(authMock.updateProfile).not.toHaveBeenCalled()
    expect(screen.getByTestId('avatar-preview').textContent).toBe('draft-avatar.png')
  })

  it('uses the canonical initial avatar when no profile image exists', () => {
    const user = authMock.state.user as { avatar: string }
    user.avatar = ''

    const { container } = renderProfilePanel()
    const avatar = container.querySelector('[title="Alice"]')

    expect(avatar).not.toBeNull()
    expect(avatar?.textContent).toBe('AL')
    expect(avatar?.className).toContain('rounded-full')
  })

  it('drops the avatar draft when canceling profile edit', () => {
    renderProfilePanel()

    fireEvent.click(screen.getByText('actions.editProfile'))
    fireEvent.click(screen.getByTestId('avatar-upload'))
    fireEvent.click(screen.getByText('cancel'))

    expect(authMock.updateProfile).not.toHaveBeenCalled()
    expect(screen.queryByTestId('avatar-upload')).toBeNull()
  })

  it('persists the cropped avatar file id only when saving profile', async () => {
    renderProfilePanel()

    fireEvent.click(screen.getByText('actions.editProfile'))
    fireEvent.click(screen.getByTestId('avatar-upload'))
    fireEvent.click(screen.getByText('save'))

    await waitFor(() => {
      expect(authMock.updateProfile).toHaveBeenCalledWith({ avatar_file_id: 'file-123' })
    })
  })

  it('sends empty strings when clearing saved nickname and bio fields', async () => {
    renderProfilePanel()

    fireEvent.click(screen.getByText('actions.editProfile'))
    fireEvent.change(screen.getByPlaceholderText('placeholders.nickname'), { target: { value: '' } })
    fireEvent.change(screen.getByPlaceholderText('placeholders.bio'), { target: { value: '' } })
    fireEvent.click(screen.getByText('save'))

    await waitFor(() => {
      expect(authMock.updateProfile).toHaveBeenCalledWith({
        nickname: '',
        bio: '',
      })
    })
  })

  it('hides email binding when the account has no email', () => {
    const user = authMock.state.user as { email: string | null }
    user.email = null

    renderProfilePanel()

    expect(screen.queryByText('actions.bindEmail')).toBeNull()
    expect(screen.queryByText('empty.email')).toBeNull()
  })

  it('trims the nickname before saving', async () => {
    renderProfilePanel()

    fireEvent.click(screen.getByText('actions.editProfile'))
    fireEvent.change(screen.getByPlaceholderText('placeholders.nickname'), { target: { value: '  Alice Cooper  ' } })
    fireEvent.click(screen.getByText('save'))

    await waitFor(() => {
      expect(authMock.updateProfile).toHaveBeenCalledWith({
        nickname: 'Alice Cooper',
      })
    })
  })

  it('saves nickname when pressing Enter in the nickname input', async () => {
    renderProfilePanel()

    fireEvent.click(screen.getByText('actions.editProfile'))
    const nicknameInput = screen.getByPlaceholderText('placeholders.nickname')
    fireEvent.change(nicknameInput, { target: { value: 'Alice Enter' } })
    fireEvent.keyDown(nicknameInput, { key: 'Enter' })

    await waitFor(() => {
      expect(authMock.updateProfile).toHaveBeenCalledWith({
        nickname: 'Alice Enter',
      })
    })
  })

  it('validates nickname length after trimming whitespace', async () => {
    renderProfilePanel()
    const nickname = 'a'.repeat(50)

    fireEvent.click(screen.getByText('actions.editProfile'))
    fireEvent.change(screen.getByPlaceholderText('placeholders.nickname'), { target: { value: `  ${nickname}  ` } })
    fireEvent.click(screen.getByText('save'))

    await waitFor(() => {
      expect(authMock.updateProfile).toHaveBeenCalledWith({ nickname })
    })
    expect(screen.queryByText('validation.nicknameLength')).toBeNull()
  })

  it('hides the account handle and username editor', () => {
    renderProfilePanel()

    expect(screen.queryByText('@alice')).toBeNull()
    fireEvent.click(screen.getByText('actions.editProfile'))

    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.queryByPlaceholderText('placeholders.username')).toBeNull()
  })

  it('hides build version from personal profile', () => {
    renderProfilePanel()

    expect(screen.queryByText('labels.buildVersion')).toBeNull()
  })

  it('shows only the empty display-name state when nickname is empty', () => {
    const user = authMock.state.user as { nickname: string }
    user.nickname = ''

    renderProfilePanel()

    expect(screen.getByText('empty.nickname')).toBeTruthy()
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.queryByText('alice')).toBeNull()
  })
})
