import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dialogHarness = vi.hoisted(() => ({
  contentProps: null as {
    onPointerDownOutside?: (event: Event) => void
    onInteractOutside?: (event: Event) => void
  } | null,
}))

vi.mock('react-easy-crop', () => ({
  default: () => <div data-testid="avatar-cropper" />,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{
    onClick?: () => void
    disabled?: boolean
  }>) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({
    children,
    onPointerDownOutside,
    onInteractOutside,
  }: React.PropsWithChildren<{
    onPointerDownOutside?: (event: Event) => void
    onInteractOutside?: (event: Event) => void
  }>) => {
    dialogHarness.contentProps = {
      onPointerDownOutside,
      onInteractOutside,
    }
    return <>{children}</>
  },
  DialogFooter: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <>{children}</>,
  toast: { error: vi.fn() },
}))

vi.mock('@/hooks/useUpload', () => ({
  useUpload: () => ({
    upload: vi.fn(),
    isUploading: false,
    progress: 0,
    cancel: vi.fn(),
  }),
}))

import { AvatarCropUploader } from './AvatarCropUploader'
import {
  __resetNativeFilePickerGuardForTests,
  isNativeFilePickerInteractionActive,
} from '@/utils/nativeFilePickerGuard'

const originalImage = globalThis.Image

beforeEach(() => {
  class MockImage {
    naturalWidth = 512
    naturalHeight = 512
    crossOrigin = ''
    onload: (() => void) | null = null
    onerror: (() => void) | null = null

    set src(_value: string) {
      queueMicrotask(() => this.onload?.())
    }
  }
  vi.stubGlobal('Image', MockImage)
})

afterEach(() => {
  vi.useRealTimers()
  vi.stubGlobal('Image', originalImage)
  __resetNativeFilePickerGuardForTests()
})

describe('AvatarCropUploader preview', () => {
  it('shows the caller fallback when the current avatar fails to load', () => {
    const { container } = render(
      <AvatarCropUploader
        currentAvatar="https://example.com/broken.png"
        uploadOptions={{
          module: 'user',
          folder: 'user-avatars',
          contextType: 'avatar',
          contextId: 'user-1',
          isPublic: true,
        }}
        onUploadComplete={vi.fn()}
        onRemove={vi.fn()}
        emptyPreview={<span>AL</span>}
      />,
    )

    const image = container.querySelector('img')
    expect(image).not.toBeNull()
    expect(container.querySelector('button[aria-label="更换"]')).not.toBeNull()
    expect(image?.getAttribute('alt')).toBe('')

    fireEvent.error(image!)

    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('AL')).toBeTruthy()
  })

  it('keeps the crop draft open after the native picker returns until the user explicitly cancels', async () => {
    const { container } = render(
      <AvatarCropUploader
        uploadOptions={{
          module: 'user',
          folder: 'user-avatars',
          contextType: 'avatar',
          contextId: 'user-1',
          isPublic: true,
        }}
        onUploadComplete={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })

    expect(await screen.findByTestId('avatar-cropper')).toBeTruthy()

    const outsideEvent = new Event('pointerdown', { cancelable: true })
    dialogHarness.contentProps?.onPointerDownOutside?.(outsideEvent)
    dialogHarness.contentProps?.onInteractOutside?.(outsideEvent)

    expect(outsideEvent.defaultPrevented).toBe(true)
    expect(screen.getByTestId('avatar-cropper')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    await waitFor(() => {
      expect(screen.queryByTestId('avatar-cropper')).toBeNull()
    })
  })

  it('marks native picker return as transiently active so focus recovery does not race file change', () => {
    vi.useFakeTimers()
    const { container } = render(
      <AvatarCropUploader
        uploadOptions={{
          module: 'user',
          folder: 'user-avatars',
          contextType: 'avatar',
          contextId: 'user-1',
          isPublic: true,
        }}
        onUploadComplete={vi.fn()}
        onRemove={vi.fn()}
      />,
    )

    expect(isNativeFilePickerInteractionActive()).toBe(false)

    const openButton = container.querySelector('button[aria-label="上传头像"]') as HTMLButtonElement
    fireEvent.click(openButton)

    expect(isNativeFilePickerInteractionActive()).toBe(true)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(isNativeFilePickerInteractionActive()).toBe(true)

    act(() => {
      vi.advanceTimersByTime(1_001)
    })
    expect(isNativeFilePickerInteractionActive()).toBe(false)
  })
})
