import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UsageBizIdCell } from './UsageBizIdCell'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

describe('UsageBizIdCell', () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('renders the full biz id in the DOM (not a shortened string)', () => {
    const fullId = 'abcdefghijklmnop-1234567890-qrstuvwxyz'
    render(<UsageBizIdCell bizId={fullId} />)

    expect(screen.getByText(fullId)).toBeTruthy()
    expect(screen.queryByText(/…/)).toBeNull()
  })

  it('copies the full biz id when the copy button is clicked', async () => {
    const fullId = 'abcdefghijklmnop-1234567890-qrstuvwxyz'
    render(<UsageBizIdCell bizId={fullId} />)

    fireEvent.click(screen.getByRole('button', { name: '复制完整业务ID' }))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(fullId)
    })
  })

  it('renders an em dash when biz id is missing', () => {
    render(<UsageBizIdCell bizId={null} />)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
