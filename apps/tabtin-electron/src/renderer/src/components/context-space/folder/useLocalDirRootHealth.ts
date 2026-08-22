/**
 * useLocalDirRootHealth — 本地目录根可达性探针
 *
 * - 挂载 / rootPath 变化时 pathExists
 * - 上层可 markMissing（FileTree 根 ENOENT / watch isRootLost）或 retry
 *
 * 不静默换根；不在此 hook 内再开 fs:watch（FileTree 已 watch，避免双开）。
 */

import { useCallback, useEffect, useState } from 'react'
import { createLogger } from '@/utils/logger'

const log = createLogger('LocalDirRootHealth')

export type LocalDirRootHealthStatus = 'unknown' | 'ok' | 'missing'

export interface LocalDirRootHealth {
  status: LocalDirRootHealthStatus
  retry: () => void
  markMissing: () => void
}

async function probeRoot(rootPath: string): Promise<'ok' | 'missing'> {
  const fs = window.tabtin?.fileSystem
  if (!fs?.pathExists) {
    // preload 异常时不阻塞用户（与 TabCodePaneHost 同款乐观兜底）
    return 'ok'
  }
  try {
    const result = await fs.pathExists(rootPath)
    const exists = !!result?.exists && (result.isDirectory ?? true)
    return exists ? 'ok' : 'missing'
  } catch (err) {
    log.warn('pathExists probe failed; treating as ok', {
      errorType: err instanceof Error ? err.name : typeof err,
    })
    return 'ok'
  }
}

export function useLocalDirRootHealth(rootPath: string | null | undefined): LocalDirRootHealth {
  const [status, setStatus] = useState<LocalDirRootHealthStatus>('unknown')
  const [probeNonce, setProbeNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    if (!rootPath) {
      setStatus('unknown')
      return
    }
    setStatus('unknown')
    void probeRoot(rootPath).then((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
    }
  }, [rootPath, probeNonce])

  const retry = useCallback(() => {
    setProbeNonce((n) => n + 1)
  }, [])

  const markMissing = useCallback(() => {
    setStatus('missing')
  }, [])

  return { status, retry, markMissing }
}
