import { useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import type { LocalMcpConnectionSummary } from '@shared/types/mcp'
import { parseMcpError } from '@shared/types/mcp'

type TFn = (key: string, opts?: Record<string, unknown>) => string

export function useMcpActions(
  loadPanelData: (mode: 'initial' | 'refresh') => Promise<LocalMcpConnectionSummary[] | null | void>,
  t: TFn,
) {
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LocalMcpConnectionSummary | null>(null)

  const runManagedAction = async (key: string, action: () => Promise<void>): Promise<boolean> => {
    setBusyKey(key)
    try {
      await action()
      await loadPanelData('refresh')
      return true
    } catch (actionError) {
      const rawMsg = actionError instanceof Error ? actionError.message : String(actionError)
      const parsed = parseMcpError(rawMsg)
      const description = parsed
        ? t(`mcpConnections.errors.${parsed.code}`, { defaultValue: rawMsg, ...parsed.params })
        : rawMsg
      toast({
        title: t('mcpConnections.actionFailed', { defaultValue: 'Action failed' }),
        description,
        variant: 'destructive',
      })
      return false
    } finally {
      setBusyKey(null)
    }
  }

  const handleCopy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(key)
      toast({ title: t('mcp.copied', { defaultValue: 'Copied to clipboard' }) })
      setTimeout(() => setCopied(null), 2000)
    } catch (copyError) {
      toast({
        title: t('mcpConnections.copyFailed', { defaultValue: '复制失败' }),
        description: copyError instanceof Error ? copyError.message : String(copyError),
        variant: 'destructive',
      })
    }
  }

  const handleDeleteConnection = (connection: LocalMcpConnectionSummary) => {
    setDeleteTarget(connection)
  }

  const confirmDeleteConnection = async () => {
    if (!deleteTarget) return
    const connection = deleteTarget
    setDeleteTarget(null)
    await runManagedAction(`delete-${connection.id}`, async () => {
      await window.tabtin.localMcp.deleteConnection(connection.id)
      toast({
        title: t('mcpConnections.deleteSuccess', { defaultValue: 'Connection deleted' }),
      })
    })
  }

  return {
    busyKey,
    setBusyKey,
    copied,
    deleteTarget,
    setDeleteTarget,
    runManagedAction,
    handleCopy,
    handleDeleteConnection,
    confirmDeleteConnection,
  }
}
