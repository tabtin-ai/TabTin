import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@components/shared/file-icon/FileIcon', () => ({
  FileIcon: () => <span data-testid="file-icon" />,
}))

import { NewItemInput } from '../NewItemInput'

describe('NewItemInput', () => {
  it('submits from the confirm button before blur can cancel the draft', () => {
    const onSubmit = vi.fn()
    const onCancel = vi.fn()

    render(
      <NewItemInput
        mode="file"
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'notes.md' } })
    fireEvent.pointerDown(screen.getByRole('button', { name: '确认新建' }))

    expect(onSubmit).toHaveBeenCalledWith('notes.md')
    expect(onCancel).not.toHaveBeenCalled()
  })
})
