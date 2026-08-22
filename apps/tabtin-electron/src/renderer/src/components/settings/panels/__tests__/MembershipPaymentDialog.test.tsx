import React from 'react'
import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MembershipPaymentDialog, type MembershipPaymentDialogProps } from '../MembershipPaymentDialog'

const { toDataURLMock } = vi.hoisted(() => ({
  toDataURLMock: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

vi.mock('qrcode', () => ({
  default: { toDataURL: toDataURLMock },
}))

const createProps = (
  overrides: Partial<MembershipPaymentDialogProps> = {},
): MembershipPaymentDialogProps => ({
  open: true,
  onOpenChange: vi.fn(),
  planName: '团队版',
  orderAmount: '166.66',
  walletBalance: '200.00',
  shortageAmount: '0.00',
  allowedMethods: {
    organization_wallet: true,
    alipay: true,
    wechat: true,
  },
  onWalletPay: vi.fn().mockResolvedValue({
    paymentStatus: 'completed',
    benefitStatus: 'completed',
  }),
  onThirdPartyPay: vi.fn().mockResolvedValue({
    order_no: 'MEMBER-001',
    payment_method: 'alipay',
    pay_url: 'https://pay.test/alipay',
  }),
  onSwitchPaymentMethod: vi.fn().mockResolvedValue({
    order_id: 'ORDER-002',
    order_no: 'MEMBER-002',
    payment_method: 'wechat',
    qr_code: 'weixin://wxpay/new-order',
  }),
  queryStatus: vi.fn().mockResolvedValue({
    paymentStatus: 'pending',
    benefitStatus: 'pending',
  }),
  onRecharge: vi.fn(),
  onSuccess: vi.fn(),
  ...overrides,
})

describe('MembershipPaymentDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toDataURLMock.mockImplementation(async (value: string) => (
      `data:image/png;base64,${encodeURIComponent(value)}`
    ))
  })

  it('supports balance, Alipay QR and WeChat QR in one desktop dialog', () => {
    render(<MembershipPaymentDialog {...createProps()} />)

    expect(screen.getByRole('button', { name: '组织余额' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '支付宝' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '微信支付' })).toBeEnabled()
  })

  it('returns to channel selection and regenerates QR when switching methods', async () => {
    const onThirdPartyPay = vi.fn().mockResolvedValue({
      order_id: 'ORDER-001',
      order_no: 'MEMBER-001',
      payment_method: 'alipay',
      pay_url: 'https://pay.test/alipay',
    })
    const onSwitchPaymentMethod = vi.fn().mockResolvedValue({
      order_id: 'ORDER-002',
      order_no: 'MEMBER-002',
      payment_method: 'wechat',
      qr_code: 'weixin://wxpay/new-order',
    })
    render(
      <MembershipPaymentDialog
        {...createProps({ onThirdPartyPay, onSwitchPaymentMethod })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '支付宝' }))
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => {
      expect(screen.getByAltText('支付宝支付二维码')).toHaveAttribute(
        'src',
        'data:image/png;base64,https%3A%2F%2Fpay.test%2Falipay',
      )
    })
    expect(onThirdPartyPay).toHaveBeenCalledWith('alipay')
    expect(screen.getByText('当前支付方式：')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '微信支付' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '更换支付方式' }))

    expect(screen.queryByAltText('支付宝支付二维码')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '微信支付' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '确认并生成二维码' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '微信支付' }))
    fireEvent.click(screen.getByRole('button', { name: '确认并生成二维码' }))

    await waitFor(() => {
      expect(screen.getByAltText('微信支付二维码')).toHaveAttribute(
        'src',
        'data:image/png;base64,weixin%3A%2F%2Fwxpay%2Fnew-order',
      )
    })
    expect(onSwitchPaymentMethod).toHaveBeenCalledWith('wechat')
  })

  it('does not report success when balance payment fails', async () => {
    const onSuccess = vi.fn()
    render(
      <MembershipPaymentDialog
        {...createProps({
          onWalletPay: vi.fn().mockRejectedValue(new Error('组织现金钱包余额不足')),
          onSuccess,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    expect(await screen.findByText('组织现金钱包余额不足')).toBeInTheDocument()
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('restores an existing WeChat QR without creating a second payment', async () => {
    const onThirdPartyPay = vi.fn()
    render(
      <MembershipPaymentDialog
        {...createProps({
          initialMethod: 'wechat',
          initialPaymentData: {
            order_no: 'MEMBER-002',
            payment_method: 'wechat',
            qr_code: 'weixin://wxpay/test',
          },
          allowedMethods: {
            organization_wallet: false,
            alipay: false,
            wechat: true,
          },
          initialPaymentStatus: 'paying',
          queryStatus: vi.fn().mockResolvedValue({
            paymentStatus: 'paying',
            benefitStatus: 'pending',
          }),
          onThirdPartyPay,
        })}
      />,
    )

    await waitFor(() => {
      expect(screen.getByAltText('微信支付二维码')).toBeInTheDocument()
    })
    expect(onThirdPartyPay).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '组织余额' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '支付宝' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '更换支付方式' })).toBeEnabled()
  })

  it('can switch from QR channel back to organization wallet when balance is enough', async () => {
    const onWalletPay = vi.fn().mockResolvedValue({
      paymentStatus: 'completed',
      benefitStatus: 'completed',
    })
    const onSuccess = vi.fn()
    render(
      <MembershipPaymentDialog
        {...createProps({
          initialMethod: 'alipay',
          initialPaymentData: {
            order_id: 'ORDER-001',
            order_no: 'MEMBER-001',
            payment_method: 'alipay',
            pay_url: 'https://pay.test/alipay',
          },
          allowedMethods: {
            organization_wallet: true,
            alipay: true,
            wechat: true,
          },
          shortageAmount: '0.00',
          walletBalance: '200.00',
          initialPaymentStatus: 'paying',
          queryStatus: vi.fn().mockResolvedValue({
            paymentStatus: 'paying',
            benefitStatus: 'pending',
          }),
          onWalletPay,
          onSuccess,
        })}
      />,
    )

    await screen.findByAltText('支付宝支付二维码')
    fireEvent.click(screen.getByRole('button', { name: '更换支付方式' }))
    expect(screen.getByRole('button', { name: '组织余额' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: '组织余额' }))
    fireEvent.click(screen.getByRole('button', { name: '确认支付' }))

    await waitFor(() => {
      expect(onWalletPay).toHaveBeenCalledTimes(1)
      expect(onSuccess).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps the current QR when the server cannot confirm the old order is closed', async () => {
    const onSwitchPaymentMethod = vi.fn().mockRejectedValue(
      new Error('暂时无法确认原支付订单已关闭，请稍后重试'),
    )
    render(
      <MembershipPaymentDialog
        {...createProps({
          initialMethod: 'wechat',
          initialPaymentData: {
            order_id: 'ORDER-001',
            order_no: 'MEMBER-001',
            payment_method: 'wechat',
            qr_code: 'weixin://wxpay/original',
          },
          initialPaymentStatus: 'paying',
          queryStatus: vi.fn().mockResolvedValue({
            paymentStatus: 'paying',
            benefitStatus: 'pending',
          }),
          onSwitchPaymentMethod,
        })}
      />,
    )

    await screen.findByAltText('微信支付二维码')
    fireEvent.click(screen.getByRole('button', { name: '更换支付方式' }))
    fireEvent.click(screen.getByRole('button', { name: '支付宝' }))
    fireEvent.click(screen.getByRole('button', { name: '确认并生成二维码' }))

    expect(await screen.findByText(
      '暂时无法确认原支付订单已关闭，请稍后重试',
    )).toBeInTheDocument()
    expect(screen.getByAltText('微信支付二维码')).toHaveAttribute(
      'src',
      'data:image/png;base64,weixin%3A%2F%2Fwxpay%2Foriginal',
    )
  })

  it('can resume the suspended QR without calling switch when selecting the same channel', async () => {
    const onSwitchPaymentMethod = vi.fn()
    render(
      <MembershipPaymentDialog
        {...createProps({
          initialMethod: 'alipay',
          initialPaymentData: {
            order_id: 'ORDER-001',
            order_no: 'MEMBER-001',
            payment_method: 'alipay',
            pay_url: 'https://pay.test/alipay',
          },
          initialPaymentStatus: 'paying',
          queryStatus: vi.fn().mockResolvedValue({
            paymentStatus: 'paying',
            benefitStatus: 'pending',
          }),
          onSwitchPaymentMethod,
        })}
      />,
    )

    await screen.findByAltText('支付宝支付二维码')
    fireEvent.click(screen.getByRole('button', { name: '更换支付方式' }))
    fireEvent.click(screen.getByRole('button', { name: '继续当前支付' }))

    await waitFor(() => {
      expect(screen.getByAltText('支付宝支付二维码')).toBeInTheDocument()
    })
    expect(onSwitchPaymentMethod).not.toHaveBeenCalled()
  })

  it('hides a QR immediately when polling reports that the order was cancelled', async () => {
    render(
      <MembershipPaymentDialog
        {...createProps({
          initialMethod: 'wechat',
          initialPaymentData: {
            order_id: 'ORDER-CANCELLED',
            order_no: 'MEMBER-CANCELLED',
            payment_method: 'wechat',
            qr_code: 'weixin://wxpay/cancelled',
          },
          initialPaymentStatus: 'paying',
          queryStatus: vi.fn().mockResolvedValue({
            paymentStatus: 'cancelled',
            benefitStatus: 'pending',
          }),
        })}
      />,
    )

    expect(await screen.findByText('当前支付订单已取消，请勿继续扫码')).toBeInTheDocument()
    expect(screen.queryByAltText('微信支付二维码')).not.toBeInTheDocument()
    expect(screen.queryByText('请使用手机扫码完成支付')).not.toBeInTheDocument()
  })

  it('shows a non-charging support message when benefit activation fails', async () => {
    render(
      <MembershipPaymentDialog
        {...createProps({
          initialMethod: 'alipay',
          initialPaymentData: {
            order_no: 'MEMBER-003',
            payment_method: 'alipay',
            pay_url: 'https://pay.test/alipay',
          },
          initialPaymentStatus: 'paid',
          initialBenefitStatus: 'failed',
          queryStatus: vi.fn().mockResolvedValue({
            paymentStatus: 'paid',
            benefitStatus: 'failed',
          }),
        })}
      />,
    )

    expect(await screen.findByText(
      '支付已成功，但权益生效失败。系统不会重复扣款，请联系客服。',
    )).toBeInTheDocument()
  })
})
