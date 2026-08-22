import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  RecordFormDialog,
  type FieldDefinition,
  type RecordFormData,
} from './record-form-dialog'

const EMPTY_FIELDS: FieldDefinition[] = []
const EMPTY_RECORD_DATA: RecordFormData = {}
const sheetHarness = vi.hoisted(() => ({
  onAnimationEnd: undefined as React.AnimationEventHandler<HTMLDivElement> | undefined,
  onPointerDownOutside: undefined as ((event: Event) => void) | undefined,
  onInteractOutside: undefined as ((event: Event) => void) | undefined,
}))

// Radix 的 portal/focus trap 在 jsdom + React 19 下会循环更新；这里只替换传输层，
// 保留 RecordFormDialog 自身的真实组合、表单与响应式 class。
vi.mock('../sheet', () => ({
  Sheet: ({ children }: React.PropsWithChildren) => <>{children}</>,
  SheetContent: ({
    children,
    side: _side,
    overlay: _overlay,
    onPointerDownOutside,
    onInteractOutside,
    onFocusOutside: _onFocusOutside,
    onOpenAutoFocus: _onOpenAutoFocus,
    onAnimationEnd,
    ...props
  }: React.PropsWithChildren<Record<string, unknown>>) => {
    sheetHarness.onAnimationEnd = onAnimationEnd as React.AnimationEventHandler<HTMLDivElement>
    sheetHarness.onPointerDownOutside = onPointerDownOutside as (event: Event) => void
    sheetHarness.onInteractOutside = onInteractOutside as (event: Event) => void
    return <div role="dialog" {...props}>{children}</div>
  },
  SheetHeader: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <header {...props}>{children}</header>,
  SheetTitle: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <h2 {...props}>{children}</h2>,
  SheetDescription: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <p {...props}>{children}</p>,
  SheetFooter: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <footer {...props}>{children}</footer>,
}))

afterEach(cleanup)

describe('RecordFormDialog secondary panel', () => {
  it('does not close when the user clicks outside the drawer', () => {
    const onOpenChange = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
      />,
    )

    const pointerEvent = { preventDefault: vi.fn() } as unknown as Event
    const interactEvent = { preventDefault: vi.fn() } as unknown as Event
    act(() => {
      sheetHarness.onPointerDownOutside?.(pointerEvent)
      sheetHarness.onInteractOutside?.(interactEvent)
    })

    expect(pointerEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(interactEvent.preventDefault).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('keeps outside dismissal enabled when creating a record', () => {
    render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        mode="create"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
      />,
    )

    const pointerEvent = { preventDefault: vi.fn(), target: document.body } as unknown as Event
    act(() => {
      sheetHarness.onPointerDownOutside?.(pointerEvent)
    })

    expect(pointerEvent.preventDefault).not.toHaveBeenCalled()
  })

  it('reports opening complete after the drawer entrance animation finishes', () => {
    const onOpenComplete = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        onOpenComplete={onOpenComplete}
        mode="edit"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    act(() => {
      sheetHarness.onAnimationEnd?.({
        target: dialog,
        currentTarget: dialog,
      } as React.AnimationEvent<HTMLDivElement>)
    })

    expect(onOpenComplete).toHaveBeenCalledTimes(1)
  })

  it('does not mark an untouched record dirty when fields hydrate while open', () => {
    const onOpenChange = vi.fn()
    const { rerender } = render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
      />,
    )

    rerender(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        fields={[{
          id: 'field-title',
          name: 'Title',
          field_type: 'text',
          is_primary: true,
          is_hidden: false,
        }]}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('discards edits and closes directly when cancel is clicked', () => {
    const onOpenChange = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        fields={[{
          id: 'field-title',
          name: 'Title',
          field_type: 'text',
          is_primary: true,
          is_hidden: false,
        }]}
        initialData={{ Title: 'Before' }}
        onSubmit={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'After' } })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('auto-saves an edit record when the form loses focus in save-on-exit mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        saveOnExit
        fields={[{
          id: 'field-title',
          name: 'Title',
          field_type: 'text',
          is_primary: true,
          is_hidden: false,
        }]}
        initialData={{ Title: 'Before' }}
        onSubmit={onSubmit}
        headerActions={<button type="button">outside-target</button>}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('button[type="submit"]')).toBeNull()

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'After' } })
    fireEvent.blur(textbox, {
      relatedTarget: screen.getByRole('button', { name: 'outside-target' }),
    })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ Title: 'After' }))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('shows a field error and retry entry when save-on-exit submission fails', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined)
    const onOpenChange = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        saveOnExit
        fields={[{
          id: 'field-title',
          name: 'Title',
          field_type: 'text',
          is_primary: true,
          is_hidden: false,
        }]}
        initialData={{ Title: 'Before' }}
        onSubmit={onSubmit}
        headerActions={<button type="button">outside-target</button>}
      />,
    )

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: 'After' } })
    fireEvent.blur(textbox, {
      relatedTarget: screen.getByRole('button', { name: 'outside-target' }),
    })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('network down')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'recordFormDialog.retry' })).toBeTruthy()
    expect(onOpenChange).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'recordFormDialog.retry' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
    expect(onSubmit).toHaveBeenLastCalledWith({ Title: 'After' })
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('allows clearing a field and closes directly in save-on-exit mode', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        saveOnExit
        fields={[{
          id: 'field-title',
          name: 'Title',
          field_type: 'text',
          is_primary: true,
          is_hidden: false,
        }]}
        initialData={{ Title: 'Before' }}
        onSubmit={onSubmit}
      />,
    )

    const textbox = screen.getByRole('textbox')
    fireEvent.change(textbox, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ Title: '' }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('saves and closes directly in save-on-exit mode without opening an unsaved prompt', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    render(
      <RecordFormDialog
        open
        onOpenChange={onOpenChange}
        mode="edit"
        recordId="record-1"
        saveOnExit
        fields={[{
          id: 'field-title',
          name: 'Title',
          field_type: 'text',
          is_primary: true,
          is_hidden: false,
        }]}
        initialData={{ Title: 'Before' }}
        onSubmit={onSubmit}
      />,
    )

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'After' } })
    fireEvent.click(screen.getByRole('dialog').querySelector('footer button[type="button"]')!)

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({ Title: 'After' }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
  })

  it('composes a header action and a secondary panel outside the record form', () => {
    render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
        preventOpenAutoFocus
        headerActions={<button type="button">评论</button>}
        secondaryPanel={<section aria-label="记录评论">评论内容</section>}
        secondaryPanelOpen
      />,
    )

    expect(screen.getByRole('button', { name: '评论' })).toBeTruthy()
    const comments = screen.getByRole('region', { name: '记录评论' })
    expect(comments.closest('form')).toBeNull()
    const aside = comments.closest('aside')
    expect(aside).not.toBeNull()

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('@container/record-detail')
    expect(dialog.className).toContain('w-[min(780px,100%)]')
    expect(dialog.querySelector('form')?.className).toContain('hidden')
    expect(dialog.querySelector('form')?.className).toContain('@[720px]/record-detail:flex')
    expect(aside?.className).toContain('flex-1')
    expect(aside?.className).toContain('@[720px]/record-detail:border-l')
  })

  it('lets the history panel take precedence over the secondary panel', () => {
    render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
        historyVisible
        historyPanel={<section aria-label="记录历史">历史内容</section>}
        secondaryPanel={<section aria-label="记录评论">评论内容</section>}
        secondaryPanelOpen
      />,
    )

    expect(screen.getByRole('region', { name: '记录历史' })).toBeTruthy()
    expect(screen.queryByRole('region', { name: '记录评论' })).toBeNull()
  })

  it('keeps the original single-panel layout when no secondary panel is open', () => {
    render(
      <RecordFormDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        fields={EMPTY_FIELDS}
        initialData={EMPTY_RECORD_DATA}
        onSubmit={vi.fn()}
      />,
    )

    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('w-full')
    expect(dialog.className).toContain('max-w-full')
    expect(dialog.className).toContain('sm:w-[420px]')
    expect(dialog.className).toContain('sm:max-w-[420px]')
    expect(dialog.querySelector('form')).not.toBeNull()
    expect(dialog.querySelector('aside')).toBeNull()
  })
})
