import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  CloudDocsListLoadError,
  isRawTechnicalLoadErrorMessage,
} from '../CloudDocsListLoadError'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: React.PropsWithChildren<{ onClick?: () => void } & Record<string, unknown>>) => (
    <button type="button" onClick={onClick} {...rest}>{children}</button>
  ),
}))

describe('CloudDocsListLoadError', () => {
  it('renders localized message and calls onRetry when reload is clicked', () => {
    const onRetry = vi.fn()
    render(<CloudDocsListLoadError message="加载失败，请重试" onRetry={onRetry} />)

    expect(screen.getByRole('alert').textContent).toContain('加载失败，请重试')
    fireEvent.click(screen.getByTestId('cloud-docs-list-reload'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('replaces raw Network/ENOTFOUND message with i18n fallback ', () => {
    render(
      <CloudDocsListLoadError
        message="Network error: getaddrinfo ENOTFOUND api.example.com"
        onRetry={() => {}}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('加载失败，请重试')
    expect(screen.getByRole('alert').textContent).not.toContain('ENOTFOUND')
  })
})

describe('isRawTechnicalLoadErrorMessage', () => {
  it('detects common transport errors', () => {
    expect(isRawTechnicalLoadErrorMessage('Network error: getaddrinfo ENOTFOUND api.example.com')).toBe(true)
    expect(isRawTechnicalLoadErrorMessage('加载失败，请重试')).toBe(false)
  })
})
