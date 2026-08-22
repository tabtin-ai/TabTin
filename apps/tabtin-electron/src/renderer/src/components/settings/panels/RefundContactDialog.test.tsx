import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RefundContactDialog } from './RefundContactDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'billing.refund.dialogTitle': '联系客服申请退款',
        'billing.refund.dialogDescription':
          '微信扫码联系客服，说明退款需求，我们将尽快为您处理。',
        'billing.refund.scanHint': '微信扫码，联系客服申请退款',
        'billing.refund.qrAlt': '客服联系二维码',
      })[key] ?? key,
  }),
}))

vi.mock('@components/ui', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="refund-dialog">{children}</div> : null,
  DialogContent: ({
    children,
    closeClassName,
  }: {
    children: React.ReactNode
    closeClassName?: string
  }) => <div data-close-class={closeClassName ?? ''}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

vi.mock('./assets/contact_me_qr.png?url', () => ({
  default: 'contact-me-qr-mock.png',
}))

describe('RefundContactDialog', () => {
  it('opens with website QR and refund copy only', () => {
    const { container } = render(<RefundContactDialog open onOpenChange={vi.fn()} />)

    expect(screen.getByTestId('refund-dialog')).toBeTruthy()
    expect(screen.getByRole('heading', { name: '联系客服申请退款' })).toBeTruthy()
    expect(screen.getByText('微信扫码，联系客服申请退款')).toBeTruthy()
    expect((screen.getByAltText('客服联系二维码') as HTMLImageElement).src).toContain(
      'contact-me-qr-mock.png',
    )
    expect(screen.queryByText(/企业微信|contact@larchiveai/i)).toBeNull()
    expect(container.querySelector('[data-close-class]')?.getAttribute('data-close-class')).toContain(
      'hover:border-primary',
    )
  })

  it('renders nothing when closed', () => {
    render(<RefundContactDialog open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByTestId('refund-dialog')).toBeNull()
  })
})
