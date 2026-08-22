import { useState, useEffect, useCallback } from 'react'
import type { DetectedBrowser } from './types'

interface UseDetectBrowsersResult {
  browsers: DetectedBrowser[]
  detecting: boolean
  refresh: () => Promise<void>
}

interface UseDetectBrowsersOptions {
  enabled?: boolean
}

let cachedBrowsers: DetectedBrowser[] | null = null

export function useDetectBrowsers(options: UseDetectBrowsersOptions = {}): UseDetectBrowsersResult {
  const enabled = options.enabled ?? true
  const [browsers, setBrowsers] = useState<DetectedBrowser[]>(cachedBrowsers || [])
  const [detecting, setDetecting] = useState(enabled && !cachedBrowsers)

  const detect = useCallback(async () => {
    if (!enabled) {
      setDetecting(false)
      return
    }
    setDetecting(true)
    try {
      const result = await window.tabtin.credentialVault.detectBrowsers()
      if (result.success) {
        cachedBrowsers = result.browsers
        setBrowsers(result.browsers)
      }
    } catch (error) {
      console.error('[useDetectBrowsers] detection failed:', error)
    } finally {
      setDetecting(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setDetecting(false)
      return
    }
    if (!cachedBrowsers) detect()
  }, [detect, enabled])

  return { browsers, detecting, refresh: detect }
}
