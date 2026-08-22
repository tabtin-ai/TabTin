import { useEffect, useState } from 'react'
import { getBuildTimeAppVersion, resolveDisplayAppVersion } from '@/utils/appVersion'

export function useAppVersion(): { version: string; loading: boolean } {
  const [version, setVersion] = useState(() => getBuildTimeAppVersion())
  const [loading, setLoading] = useState(() => !getBuildTimeAppVersion())

  useEffect(() => {
    if (version) {
      setLoading(false)
      return
    }

    let cancelled = false
    resolveDisplayAppVersion()
      .then((resolved) => {
        if (!cancelled && resolved) setVersion(resolved)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [version])

  return { version, loading }
}
