import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { CodeSelectionToolbar } from './CodeSelectionToolbar'
import type { CodeSelectionData } from './codeSelection'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

vi.mock('@components/ui', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  OVERLAY_SURFACE_CLASS: 'overlay-surface',
}))

const selection: CodeSelectionData = {
  text: 'const x = 1',
  startLine: 3,
  endLine: 3,
  anchor: { top: 180, bottom: 200, centerX: 320 },
}

describe('CodeSelectionToolbar', () => {
  it('renders add-to-chat and invokes callback', () => {
    const onAdd = vi.fn()
    const portalRoot = document.createElement('div')
    document.body.appendChild(portalRoot)

    render(
      <CodeSelectionToolbar
        selection={selection}
        onAddToChat={onAdd}
        portalRoot={portalRoot}
      />,
    )

    expect(screen.queryByText('快速编辑')).toBeNull()
    fireEvent.click(screen.getByText('添加到对话'))
    expect(onAdd).toHaveBeenCalledWith(selection)

    portalRoot.remove()
  })

  it('hides when selection has no anchor', () => {
    const portalRoot = document.createElement('div')
    document.body.appendChild(portalRoot)

    render(
      <CodeSelectionToolbar
        selection={{ text: 'x', startLine: 1, endLine: 1 }}
        onAddToChat={() => {}}
        portalRoot={portalRoot}
      />,
    )

    expect(screen.queryByText('添加到对话')).toBeNull()
    portalRoot.remove()
  })
})
