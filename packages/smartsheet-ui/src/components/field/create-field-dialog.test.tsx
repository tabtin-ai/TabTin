import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { CreateFieldDialog } from './create-field-dialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('../dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div role="dialog">{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <footer>{children}</footer>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}))

vi.mock('../scroll-area', () => ({
  ScrollArea: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}))

vi.mock('../field-config/FieldConfigFormBody', () => ({
  FieldConfigFormBody: ({
    setName,
    errors,
  }: {
    setName: (value: string) => void
    errors: Record<string, string>
  }) => (
    <>
      <input aria-label="字段名称" onChange={(event) => setName(event.target.value)} />
      {errors.name && <p data-testid="field-name-error">{errors.name}</p>}
    </>
  ),
}))

vi.mock('./select-choices-editor', () => ({
  SelectChoicesEditor: () => null,
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const setInputValue = (input: HTMLInputElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const findButton = (container: HTMLElement, label: string): HTMLButtonElement => {
  const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === label)
  if (!button) throw new Error(`Button not found: ${label}`)
  return button
}

describe('CreateFieldDialog submit lifecycle', () => {
  it('still rejects a field name that existed before submission', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const onSubmit = vi.fn()

    try {
      act(() => {
        root.render(
          <CreateFieldDialog
            open
            onOpenChange={vi.fn()}
            onSubmit={onSubmit}
            tableFields={[{ id: 'field-quantity', name: '数量', field_type: 'number' }]}
          />,
        )
      })

      setInputValue(container.querySelector('input[aria-label="字段名称"]')!, '数量')
      act(() => findButton(container, '创建字段').click())

      expect(onSubmit).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="field-name-error"]')?.textContent).toBeTruthy()
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })

  it('prevents a refreshed field list from turning an in-flight create into a duplicate retry', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let resolveSubmit: (() => void) | undefined
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => {
      resolveSubmit = resolve
    }))
    const onOpenChange = vi.fn()

    try {
      act(() => {
        root.render(
          <CreateFieldDialog
            open
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
            tableFields={[]}
          />,
        )
      })

      setInputValue(container.querySelector('input[aria-label="字段名称"]')!, '数量')
      act(() => findButton(container, '创建字段').click())

      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(findButton(container, '创建中...').disabled).toBe(true)

      act(() => {
        root.render(
          <CreateFieldDialog
            open
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
            tableFields={[{ id: 'field-quantity', name: '数量', field_type: 'number' }]}
          />,
        )
      })

      act(() => findButton(container, '创建中...').click())
      expect(onSubmit).toHaveBeenCalledTimes(1)
      expect(container.textContent).not.toContain('已存在')

      await act(async () => resolveSubmit?.())
      expect(onOpenChange).toHaveBeenCalledWith(false)
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
