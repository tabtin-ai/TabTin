/**
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocList, type UseDocListReturn } from '../useDocList'

const {
  createDocumentMock,
  listDocumentsMock,
  searchDocumentsMock,
} = vi.hoisted(() => ({
  createDocumentMock: vi.fn(),
  listDocumentsMock: vi.fn(),
  searchDocumentsMock: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      typeof options?.time === 'string' ? `New document ${options.time}` : key,
  }),
}))

vi.mock('@tabtin/app-host-sdk', () => ({
  useAppHostClient: () => ({}),
}))

vi.mock('../api-client', () => ({
  createDocument: createDocumentMock,
  listDocuments: listDocumentsMock,
  searchDocuments: searchDocumentsMock,
}))

function Harness({
  onValue,
}: {
  onValue: (value: UseDocListReturn) => void
}) {
  const value = useDocList({ organizationId: 'wt-1', spaceId: 'sp-1' })

  useEffect(() => {
    onValue(value)
  }, [onValue, value])

  return null
}

describe('useDocList create guard', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: UseDocListReturn | null

  beforeEach(() => {
    latest = null
    createDocumentMock.mockReset()
    listDocumentsMock.mockResolvedValue({ documents: [], total: 0 })
    searchDocumentsMock.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('deduplicates repeated create clicks while the request is pending', async () => {
    let resolveCreate: ((value: unknown) => void) | null = null
    createDocumentMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    )

    await act(async () => {
      root.render(
        <Harness onValue={(value) => { latest = value }} />,
      )
    })

    expect(latest).not.toBeNull()

    let firstCreate: Promise<unknown>
    let secondCreate: Promise<unknown>
    act(() => {
      firstCreate = latest!.createNew()
      secondCreate = latest!.createNew()
    })

    expect(createDocumentMock).toHaveBeenCalledTimes(1)
    await expect(secondCreate!).resolves.toBeNull()

    const document = {
      id: 'doc-1',
      title: 'New document',
      latest_version: 0,
      updated_at: null,
    }

    await act(async () => {
      resolveCreate?.({ document })
      await firstCreate!
    })

    await expect(firstCreate!).resolves.toBe(document)
  })
})
