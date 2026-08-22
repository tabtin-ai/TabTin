import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { writeMock, toastSuccessMock } = vi.hoisted(() => ({
  writeMock: vi.fn(async () => undefined),
  toastSuccessMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}))
vi.mock('@tabtin/smartsheet-ui/toast', () => ({ toast: { success: toastSuccessMock, error: vi.fn() } }))
vi.mock('@/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/logger')>()),
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

import { FileKindPreview } from './FileKindPreview'

describe('FileKindPreview image context menu', () => {
  beforeEach(() => {
    writeMock.mockClear()
    toastSuccessMock.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]).buffer, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })))
    vi.stubGlobal('navigator', { clipboard: { write: writeMock } })
    vi.stubGlobal('ClipboardItem', class {
      constructor(_parts: Record<string, Promise<Blob>>) {}
    })
  })

  it('lets a folder image preview copy the image from its context menu', async () => {
    render(<FileKindPreview kind="image" fileName="photo.png" filePath="C:/pictures/photo.png" unsupportedLabel="unsupported" />)

    fireEvent.contextMenu(screen.getByRole('img', { name: 'photo.png' }), { clientX: 30, clientY: 40 })
    fireEvent.click(screen.getByRole('menuitem', { name: '复制图片' }))

    await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(1))
    expect(toastSuccessMock).toHaveBeenCalledWith('已复制图片')
  })
})
