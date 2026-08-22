import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommentComposer } from './CommentComposer'

function Harness({
  onSubmit = vi.fn(),
  onUploadImage,
}: {
  onSubmit?: (input: { body: string; attachmentIds: string[]; clientRequestId: string }) => void
  onUploadImage?: (file: File) => Promise<{ fileId: string }>
}) {
  const [value, setValue] = useState('')
  return (
    <CommentComposer
      value={value}
      onValueChange={setValue}
      onSubmit={onSubmit}
      onUploadImage={onUploadImage}
    />
  )
}

describe('CommentComposer', () => {
  it('文档评论输入区按内容增长，超过 400px 后在输入区内滚动', async () => {
    render(<Harness />)

    const textarea = screen.getByPlaceholderText('输入评论，可粘贴或拖入图片') as HTMLTextAreaElement
    expect(textarea.rows).toBe(2)
    expect(textarea.className).toContain('max-h-[400px]')

    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 480,
    })
    fireEvent.change(textarea, { target: { value: '多行评论内容' } })

    await waitFor(() => expect(textarea.style.height).toBe('400px'))
    expect(textarea.style.overflowY).toBe('auto')
  })

  it('纯图片可提交', async () => {
    const onSubmit = vi.fn()
    const onUploadImage = vi.fn(async () => ({ fileId: 'file-1' }))
    render(<Harness onSubmit={onSubmit} onUploadImage={onUploadImage} />)

    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(onUploadImage).toHaveBeenCalled())
    await waitFor(() => {
      expect((screen.getByLabelText('发送') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        body: '',
        attachmentIds: ['file-1'],
      }))
    })
  })

  it('发送成功后清空已上传图片，避免下一轮复用已绑定附件', async () => {
    const onSubmit = vi.fn(async () => undefined)
    const onUploadImage = vi.fn(async () => ({ fileId: 'file-1' }))
    render(<Harness onSubmit={onSubmit} onUploadImage={onUploadImage} />)

    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => {
      expect(screen.getByTestId('comment-composer-images')).toBeTruthy()
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    await waitFor(() => {
      expect(screen.queryByTestId('comment-composer-images')).toBeNull()
    })
  })

  it('发送失败时保留已上传图片', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('评论附件已绑定到其他消息')
    })
    const onUploadImage = vi.fn(async () => ({ fileId: 'file-1' }))
    render(<Harness onSubmit={onSubmit} onUploadImage={onUploadImage} />)

    const file = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => {
      expect((screen.getByLabelText('发送') as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalled())
    expect(screen.getByTestId('comment-composer-images')).toBeTruthy()
  })

  it('相同草稿失败重试复用 clientRequestId，内容变化后才换新', async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error('响应丢失')
    })
    render(<Harness onSubmit={onSubmit} />)

    const textarea = screen.getByPlaceholderText('输入评论，可粘贴或拖入图片')
    fireEvent.change(textarea, { target: { value: '同一份草稿' } })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))

    const firstId = onSubmit.mock.calls[0]![0].clientRequestId
    const retryId = onSubmit.mock.calls[1]![0].clientRequestId
    expect(retryId).toBe(firstId)

    fireEvent.change(textarea, { target: { value: '草稿已变化' } })
    fireEvent.click(screen.getByLabelText('发送'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(3))
    expect(onSubmit.mock.calls[2]![0].clientRequestId).not.toBe(firstId)
  })
})
