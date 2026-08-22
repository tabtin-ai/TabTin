import { useEffect, useState } from 'react'
import { useAppVersion } from '@/hooks/useAppVersion'
import { apiService, type RuntimeVersionInfo } from '@/services/api'
import { API_BASE_URL } from '@/config/api'

const EMPTY_SERVER_VERSION: RuntimeVersionInfo = {
  release_version: '',
  source_sha: '',
}

export function useRuntimeVersionInfo(enabled: boolean) {
  const { version: clientVersion } = useAppVersion()
  const [server, setServer] = useState(EMPTY_SERVER_VERSION)
  const [serverLoading, setServerLoading] = useState(false)

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    setServerLoading(true)
    apiService.healthCheck()
      .then((response) => {
        if (!cancelled) setServer(response)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setServerLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  return {
    clientVersion,
    clientSourceSha: import.meta.env.VITE_GIT_COMMIT || '',
    serverVersion: server.release_version,
    serverSourceSha: server.source_sha,
    serverAddress: API_BASE_URL,
    serverLoading,
  }
}
