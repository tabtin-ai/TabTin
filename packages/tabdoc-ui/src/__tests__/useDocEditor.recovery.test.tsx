/**
 * @vitest-environment jsdom
 */

import React, { useEffect } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDocEditor, type UseDocEditorReturn } from '../useDocEditor'

const {
  createRecoveryDraftMock,
  getDocumentMock,
  saveDraftMock,
  deleteDraftMock,
  loadDraftMock,
  controller,
} = vi.hoisted(() => ({
  createRecoveryDraftMock: vi.fn(),
  getDocumentMock: vi.fn(),
  saveDraftMock: vi.fn(),
  deleteDraftMock: vi.fn(),
  loadDraftMock: vi.fn(),
  controller: {
    cancel: vi.fn(),
    discardPendingDraft: vi.fn(),
    flush: vi.fn(),
    isDirty: vi.fn(() => false),
    markDirty: vi.fn(),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tabtin/app-host-sdk', () => ({
  useAppHostClient: () => ({}),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@tabtin/doc-editor', () => ({
  configureDocEditorHost: vi.fn(),
  createAutoSaveController: vi.fn(() => controller),
  markdownToPlaintext: (markdown: string) => markdown,
  markdownToPmJson: (markdown: string) => ({
    type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
  }),
  registerProbeIntent: vi.fn(),
  unregisterProbeIntent: vi.fn(),
  resetDocEditorHost: vi.fn(),
}))

vi.mock('../api-client', () => ({
  createRecoveryDraft: createRecoveryDraftMock,
  getDocument: getDocumentMock,
  saveContent: vi.fn(),
}))

vi.mock('../utils/offlineCache', () => ({
  cleanupExpiredDrafts: vi.fn(() => Promise.resolve()),
  deleteDraft: deleteDraftMock,
  loadDraft: loadDraftMock,
  saveDraft: saveDraftMock,
}))

function detail(version: number, markdown: string) {
  return {
    document: {
      id: 'doc-recovery',
      latest_version: version,
      updated_at: `2026-08-01T00:00:0${version}Z`,
      title: 'Recovery test',
    },
    content: {
      description_json: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: markdown }] }],
      },
      description_markdown: markdown,
      description_plaintext: markdown,
    },
    latest_revision: null,
  }
}

function Harness({ onValue }: { onValue: (value: UseDocEditorReturn) => void }) {
  const value = useDocEditor({ documentId: 'doc-recovery' })
  useEffect(() => { onValue(value) }, [onValue, value])
  return null
}

describe('useDocEditor recovery draft flow', () => {
  let container: HTMLDivElement
  let root: Root
  let latest: UseDocEditorReturn | null

  beforeEach(() => {
    latest = null
    vi.clearAllMocks()
    controller.isDirty.mockReturnValue(false)
    loadDraftMock.mockResolvedValue(null)
    deleteDraftMock.mockResolvedValue(undefined)
    saveDraftMock.mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  async function mountWithInitialDocument() {
    getDocumentMock.mockResolvedValueOnce(detail(1, 'cloud v1'))
    await act(async () => {
      root.render(<Harness onValue={(value) => { latest = value }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest?.activeDocumentIdRef.current).toBe('doc-recovery')
    act(() => {
      latest?.handleEditorUpdate('local unsaved', {
        type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'local unsaved' }] }],
      })
    })
  }

  it('keeps the IndexedDB draft and reuses one recovery record when remote fetch fails', async () => {
    await mountWithInitialDocument()
    createRecoveryDraftMock.mockResolvedValue({ id: 'recovery-1' })
    getDocumentMock.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(detail(2, 'cloud v2'))

    let firstResult: Awaited<ReturnType<UseDocEditorReturn['recoverFromExternalUpdate']>>
    await act(async () => {
      firstResult = await latest!.recoverFromExternalUpdate()
    })

    expect(firstResult!.action).toBe('blocked')
    expect(createRecoveryDraftMock).toHaveBeenCalledTimes(1)
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-recovery', markdown: 'local unsaved',
    }))
    expect(deleteDraftMock).not.toHaveBeenCalled()
    expect(controller.discardPendingDraft).not.toHaveBeenCalled()

    let secondResult: Awaited<ReturnType<UseDocEditorReturn['recoverFromExternalUpdate']>>
    await act(async () => {
      secondResult = await latest!.recoverFromExternalUpdate()
    })

    expect(secondResult!.action).toBe('resolved')
    expect(createRecoveryDraftMock).toHaveBeenCalledTimes(1)
    expect(controller.discardPendingDraft).toHaveBeenCalledOnce()
    expect(deleteDraftMock).toHaveBeenCalledWith('doc-recovery')
    expect(latest?.initialMarkdown).toBe('cloud v2')
  })

  it('creates a fresh recovery record for edits made after a failed remote fetch', async () => {
    await mountWithInitialDocument()
    createRecoveryDraftMock
      .mockResolvedValueOnce({ id: 'recovery-1' })
      .mockResolvedValueOnce({ id: 'recovery-2' })
    getDocumentMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(detail(2, 'cloud v2'))

    await act(async () => {
      await latest!.recoverFromExternalUpdate()
    })

    act(() => {
      latest?.handleEditorUpdate('local unsaved plus new input', {
        type: 'doc', content: [{
          type: 'paragraph', content: [{ type: 'text', text: 'local unsaved plus new input' }],
        }],
      })
    })

    let result: Awaited<ReturnType<UseDocEditorReturn['recoverFromExternalUpdate']>>
    await act(async () => {
      result = await latest!.recoverFromExternalUpdate()
    })

    expect(result!.action).toBe('resolved')
    expect(createRecoveryDraftMock).toHaveBeenCalledTimes(2)
    expect(createRecoveryDraftMock).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'doc-recovery',
      expect.objectContaining({ markdown: 'local unsaved plus new input' }),
    )
    expect(controller.discardPendingDraft).toHaveBeenCalledOnce()
    expect(deleteDraftMock).toHaveBeenCalledWith('doc-recovery')
    expect(latest?.initialMarkdown).toBe('cloud v2')
  })

  it('keeps the IndexedDB draft when recovery upload itself fails', async () => {
    await mountWithInitialDocument()
    createRecoveryDraftMock.mockRejectedValueOnce(new Error('upload failed'))

    let result: Awaited<ReturnType<UseDocEditorReturn['recoverFromExternalUpdate']>>
    await act(async () => {
      result = await latest!.recoverFromExternalUpdate()
    })

    expect(result!.action).toBe('blocked')
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-recovery', markdown: 'local unsaved',
    }))
    expect(deleteDraftMock).not.toHaveBeenCalled()
    expect(controller.discardPendingDraft).not.toHaveBeenCalled()
    expect(latest?.initialMarkdown).toBe('cloud v1')
  })

  it('keeps the IndexedDB draft when the fetched remote body cannot be applied', async () => {
    await mountWithInitialDocument()
    createRecoveryDraftMock.mockResolvedValue({ id: 'recovery-1' })
    getDocumentMock.mockResolvedValueOnce(detail(2, 'x'.repeat(5 * 1024 * 1024 + 1)))

    let result: Awaited<ReturnType<UseDocEditorReturn['recoverFromExternalUpdate']>>
    await act(async () => {
      result = await latest!.recoverFromExternalUpdate()
    })

    expect(result!.action).toBe('blocked')
    expect(createRecoveryDraftMock).toHaveBeenCalledOnce()
    expect(saveDraftMock).toHaveBeenCalledWith(expect.objectContaining({
      documentId: 'doc-recovery', markdown: 'local unsaved',
    }))
    expect(deleteDraftMock).not.toHaveBeenCalled()
    expect(controller.discardPendingDraft).not.toHaveBeenCalled()
    expect(latest?.initialMarkdown).toBe('cloud v1')
  })
})
