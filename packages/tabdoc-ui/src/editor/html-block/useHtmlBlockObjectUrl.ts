import { useEffect, useState } from 'react'
import { useHtmlArtifactLoaderOptional } from './HtmlArtifactLoaderContext'

export interface UseHtmlBlockObjectUrlOptions {
  fileId: string
  /** Historical public URL fallback when no loader / private fetch fails. */
  legacySrc?: string
  documentId?: string
  shareId?: string
  password?: string
  /** Bumped by share-page access recheck failures to revoke blobs. */
  revokeEpoch?: number
}

export interface UseHtmlBlockObjectUrlResult {
  iframeSrc: string
  loading: boolean
  error: string | null
  isPrivateResolved: boolean
}

/**
 * Resolve htmlBlock iframe src via authorized Blob fetch .
 * Never writes blob: back into ProseMirror attrs.
 */
export function useHtmlBlockObjectUrl(
  options: UseHtmlBlockObjectUrlOptions,
): UseHtmlBlockObjectUrlResult {
  const loader = useHtmlArtifactLoaderOptional()
  const fileId = (options.fileId || '').trim()
  const legacySrc = (options.legacySrc || '').trim()
  const [iframeSrc, setIframeSrc] = useState('')
  const [loading, setLoading] = useState(Boolean(fileId && loader))
  const [error, setError] = useState<string | null>(null)
  const [isPrivateResolved, setIsPrivateResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    let objectUrl: string | null = null
    const controller = new AbortController()

    async function resolve() {
      setError(null)
      setIsPrivateResolved(false)

      if (!fileId) {
        setIframeSrc(legacySrc)
        setLoading(false)
        return
      }

      // Private blocks persist fileId with empty src; without a host loader they cannot
      // resolve. Prefer "load failed" over the misleading "not linked" empty state.
      if (!loader) {
        if (legacySrc) {
          setIframeSrc(legacySrc)
          setError(null)
        } else {
          setIframeSrc('')
          setError('HTML artifact loader unavailable')
        }
        setLoading(false)
        return
      }

      setLoading(true)
      try {
        const blob = await loader({
          fileId,
          documentId: options.documentId,
          shareId: options.shareId,
          password: options.password,
          signal: controller.signal,
        })
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setIframeSrc(objectUrl)
        setIsPrivateResolved(true)
        setLoading(false)
      } catch (err) {
        if (cancelled || controller.signal.aborted) return
        // Historical public src remains usable for unmigrated blocks.
        if (legacySrc) {
          setIframeSrc(legacySrc)
          setIsPrivateResolved(false)
          setError(null)
        } else {
          setIframeSrc('')
          setError(err instanceof Error ? err.message : 'HTML artifact load failed')
        }
        setLoading(false)
      }
    }

    void resolve()

    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [
    fileId,
    legacySrc,
    loader,
    options.documentId,
    options.shareId,
    options.password,
    options.revokeEpoch,
  ])

  return { iframeSrc, loading, error, isPrivateResolved }
}
