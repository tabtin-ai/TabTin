import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MobileEnvironmentQrDialog } from './MobileEnvironmentQrDialog'

const toDataURL = vi.hoisted(() => vi.fn())

vi.mock('qrcode', () => ({
  default: { toDataURL },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { address?: string }) =>
      options?.address ? `${key}:${options.address}` : key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <header>{children}</header>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      aria-label="network-address"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string
    children: React.ReactNode
  }) => <option value={value}>{children}</option>,
}))

const loopbackConfig = {
  apiUrl: 'http://127.0.0.1:6060/api',
  websocketUrl: 'ws://127.0.0.1:6060/ws/v1/gateway',
  webUrl: 'http://127.0.0.1:5176',
  centrifugoUrl: 'ws://127.0.0.1:8100/connection/websocket',
}

describe('MobileEnvironmentQrDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    toDataURL.mockResolvedValue('data:image/png;base64,qr')
  })

  it('selects a local address and regenerates every loopback endpoint', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        getLocalNetworkAddresses: async () => [
          { interfaceName: 'en0', address: '192.168.1.20' },
          { interfaceName: 'utun5', address: '10.8.0.2' },
        ],
      },
    })

    render(
      <MobileEnvironmentQrDialog
        open
        onOpenChange={vi.fn()}
        config={loopbackConfig}
      />,
    )

    await waitFor(() => expect(toDataURL).toHaveBeenCalled())
    let payload = new URL(toDataURL.mock.calls.at(-1)?.[0])
    expect(payload.searchParams.get('api')).toBe('http://192.168.1.20:6060/api')
    expect(payload.searchParams.get('web')).toBe('http://192.168.1.20:5176')
    expect(
      screen.getByText('update.mobileEnvironmentNetworkNotice'),
    ).toBeTruthy()

    fireEvent.change(
      screen.getByRole('combobox', { name: 'network-address' }),
      {
        target: { value: '10.8.0.2' },
      },
    )

    await waitFor(() => {
      payload = new URL(toDataURL.mock.calls.at(-1)?.[0])
      expect(payload.searchParams.get('centrifugo')).toBe(
        'ws://10.8.0.2:8100/connection/websocket',
      )
    })
    expect(
      screen.getByText('update.mobileEnvironmentAddressSelected:10.8.0.2'),
    ).toBeTruthy()
  })

  it('does not generate an unusable QR code when no local address is available', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { getLocalNetworkAddresses: async () => [] },
    })

    render(
      <MobileEnvironmentQrDialog
        open
        onOpenChange={vi.fn()}
        config={loopbackConfig}
      />,
    )

    expect(
      await screen.findByText('update.mobileEnvironmentNoAddress'),
    ).toBeTruthy()
    expect(
      screen.getByText('update.mobileEnvironmentQrUnavailable'),
    ).toBeTruthy()
    expect(toDataURL).not.toHaveBeenCalled()
  })
})
