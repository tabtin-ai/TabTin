import { act, renderHook, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HtmlArtifactLoaderProvider } from './HtmlArtifactLoaderContext'
import { useHtmlBlockObjectUrl } from './useHtmlBlockObjectUrl'

describe('useHtmlBlockObjectUrl', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates blob URL from loader and revokes on unmount / revokeEpoch', async () => {
    const createObjectURL = vi.fn(() => 'blob:mock-1')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL,
      revokeObjectURL,
    })

    const loader = vi.fn().mockResolvedValue(new Blob(['x'], { type: 'text/html' }))
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <HtmlArtifactLoaderProvider value={loader}>{children}</HtmlArtifactLoaderProvider>
    )

    const { result, rerender, unmount } = renderHook(
      ({ revokeEpoch }) =>
        useHtmlBlockObjectUrl({
          fileId: 'file-1',
          documentId: 'doc-1',
          revokeEpoch,
        }),
      { wrapper, initialProps: { revokeEpoch: 0 } },
    )

    await waitFor(() => {
      expect(result.current.iframeSrc).toBe('blob:mock-1')
      expect(result.current.isPrivateResolved).toBe(true)
    })
    expect(loader).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'file-1', documentId: 'doc-1' }),
    )

    await act(async () => {
      rerender({ revokeEpoch: 1 })
    })
    await waitFor(() => {
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-1')
    })

    unmount()
    expect(revokeObjectURL.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to legacy src when loader fails', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('forbidden'))
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <HtmlArtifactLoaderProvider value={loader}>{children}</HtmlArtifactLoaderProvider>
    )

    const { result } = renderHook(
      () =>
        useHtmlBlockObjectUrl({
          fileId: 'file-legacy',
          documentId: 'doc-1',
          legacySrc: 'https://cdn.example.com/old.html',
        }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.iframeSrc).toBe('https://cdn.example.com/old.html')
      expect(result.current.isPrivateResolved).toBe(false)
      expect(result.current.error).toBeNull()
    })
  })

  it('surfaces error when private load fails without legacy src', async () => {
    const loader = vi.fn().mockRejectedValue(new Error('not found'))
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <HtmlArtifactLoaderProvider value={loader}>{children}</HtmlArtifactLoaderProvider>
    )

    const { result } = renderHook(
      () =>
        useHtmlBlockObjectUrl({
          fileId: 'file-private',
          documentId: 'doc-1',
        }),
      { wrapper },
    )

    await waitFor(() => {
      expect(result.current.iframeSrc).toBe('')
      expect(result.current.error).toMatch(/not found/)
    })
  })

  it('surfaces load-failed when fileId exists but host loader is missing', async () => {
    const { result } = renderHook(() =>
      useHtmlBlockObjectUrl({
        fileId: 'file-orphan',
        documentId: 'doc-1',
      }),
    )

    await waitFor(() => {
      expect(result.current.iframeSrc).toBe('')
      expect(result.current.error).toMatch(/loader unavailable/)
    })
  })
})
