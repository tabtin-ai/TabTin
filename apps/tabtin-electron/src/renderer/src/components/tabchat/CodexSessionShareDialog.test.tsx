import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockRead, mockUpload } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockUpload: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@components/ui', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Progress: ({ value }: { value: number }) => <progress value={value} max={100} />,
  toast: vi.fn(),
}))

vi.mock('@/services/tabchatAttachmentApi', () => ({
  uploadIMAttachment: mockUpload,
}))

describe('CodexSessionShareDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.tabtin = {
      ...window.tabtin,
      codexSessionShare: {
        ...window.tabtin?.codexSessionShare,
        read: mockRead,
      },
    } as typeof window.tabtin
  })

  it('cancels before upload and message send when the session path is missing', async () => {
    const { CodexSessionShareDialog } = await import('./CodexSessionShareDialog')
    mockRead.mockRejectedValue(new Error('找不到该 Codex session'))
    const onSend = vi.fn()
    render(
      <CodexSessionShareDialog
        isOpen
        onClose={vi.fn()}
        conversationId="conversation-1"
        onSend={onSend}
      />,
    )

    fireEvent.change(screen.getByLabelText('Session ID'), {
      target: { value: '019ff047-d01a-73e3-bea6-26d65f98d7a8' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送会话文件' }))

    await screen.findByText('发送已取消，请检查 Session ID 后重试')
    await waitFor(() => expect(mockRead).toHaveBeenCalledOnce())
    expect(mockUpload).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
  })

  it('includes an optional suggested working directory in the card contract', async () => {
    const { CodexSessionShareDialog } = await import('./CodexSessionShareDialog')
    mockRead.mockResolvedValue({
      buffer: new Uint8Array([0x50, 0x4b]).buffer,
      fileName: 'session.zip',
      sessionId: '019ff047-d01a-73e3-bea6-26d65f98d7a8',
      title: '排查导入问题',
    })
    mockUpload.mockResolvedValue({
      file_id: 'file-1',
      file_name: 'session.zip',
      file_size: 128,
      file_type: 'application/zip',
    })
    const onSend = vi.fn()
    render(
      <CodexSessionShareDialog
        isOpen
        onClose={vi.fn()}
        conversationId="conversation-1"
        onSend={onSend}
      />,
    )

    fireEvent.change(screen.getByLabelText('Session ID'), {
      target: { value: '019ff047-d01a-73e3-bea6-26d65f98d7a8' },
    })
    fireEvent.change(screen.getByLabelText('建议工作目录（可选）'), {
      target: { value: '  /workspace/TabTin  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: '发送会话文件' }))

    await waitFor(() => expect(onSend).toHaveBeenCalledOnce())
    expect(onSend.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
      card: expect.objectContaining({
        suggested_working_directory: '/workspace/TabTin',
      }),
    }))
  })

})
