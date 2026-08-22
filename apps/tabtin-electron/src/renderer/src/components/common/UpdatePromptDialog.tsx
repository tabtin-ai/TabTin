import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import type {
  OverlayUpdatePromptActionPayload,
  OverlayUpdatePromptInfo,
  OverlayUpdatePromptStatus,
} from '@shared/overlay/types'

type UpdateStatus = OverlayUpdatePromptStatus
type UpdateInfoLike = OverlayUpdatePromptInfo

type UpdateRuntimeState = {
  currentVersion?: string
  status?: UpdateStatus
  downloadProgress?: number
  updateInfo?: UpdateInfoLike | null
  errorMessage?: string | null
  lastCheckedAt?: string | null
}

export const UpdatePromptDialog: React.FC = () => {
  const openSettings = useSettingsSpaceStore((state) => state.openSettings)
  const pushedOpenRef = useRef(false)
  const [currentVersion, setCurrentVersion] = useState('')
  const [status, setStatus] = useState<UpdateStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState(0)
  const [updateInfo, setUpdateInfo] = useState<UpdateInfoLike | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)
  const [dismissedErrorKey, setDismissedErrorKey] = useState<string | null>(null)
  const [restartDialogOpen, setRestartDialogOpen] = useState(false)

  const applyRuntimeState = useCallback((snapshot: UpdateRuntimeState | null | undefined) => {
    if (!snapshot) return
    if (snapshot.currentVersion) setCurrentVersion(snapshot.currentVersion)
    if (snapshot.status) setStatus(snapshot.status)
    if (typeof snapshot.downloadProgress === 'number') {
      setDownloadProgress(Math.round(snapshot.downloadProgress))
    }
    if (snapshot.updateInfo !== undefined) {
      setUpdateInfo(snapshot.updateInfo ?? null)
    }
    if (typeof snapshot.errorMessage === 'string') {
      setErrorMessage(snapshot.errorMessage)
    } else if (snapshot.errorMessage === null) {
      setErrorMessage('')
    }
  }, [])

  useEffect(() => {
    window.tabtin.updater.getAppVersion().then(setCurrentVersion).catch(() => {})
    window.tabtin.updater.getState?.().then(applyRuntimeState).catch(() => {})

    const cleanup = window.tabtin.updater.onUpdateEvent((payload) => {
      const { event, data } = payload
      switch (event) {
        case 'update-state':
          applyRuntimeState(data)
          break
        case 'update-checking':
          setStatus('checking')
          setErrorMessage('')
          setDismissedErrorKey(null)
          setRestartDialogOpen(false)
          break
        case 'update-available':
          setStatus('available')
          setUpdateInfo(data ?? null)
          setDismissedVersion(null)
          setDismissedErrorKey(null)
          setErrorMessage('')
          setRestartDialogOpen(false)
          break
        case 'download-progress':
          setStatus('downloading')
          setDownloadProgress(Math.round(data?.percent ?? 0))
          break
        case 'update-downloaded':
          setStatus('downloaded')
          setDownloadProgress(100)
          setUpdateInfo(data ?? null)
          setDismissedVersion(null)
          setDismissedErrorKey(null)
          break
        case 'update-installing':
          setStatus('installing')
          setRestartDialogOpen(true)
          break
        case 'update-error':
          setStatus('error')
          setErrorMessage(typeof data === 'string' ? data : '更新失败，请稍后重试')
          setDismissedVersion(null)
          setRestartDialogOpen(false)
          break
        case 'update-restart-dialog-open':
          setRestartDialogOpen(true)
          break
        case 'update-restart-dialog-closed':
          setRestartDialogOpen(false)
          break
      }
    })

    return cleanup
  }, [applyRuntimeState])

  const targetVersion = String(updateInfo?.version ?? '')
  const errorKey = `${targetVersion || 'unknown'}:${errorMessage || '更新失败'}`
  const visible = useMemo(() => {
    if (restartDialogOpen || status === 'installing') return false
    if (status === 'available' && targetVersion && dismissedVersion !== targetVersion) return true
    if (status === 'downloading' || status === 'downloaded' || status === 'error') return true
    return false
  }, [dismissedVersion, restartDialogOpen, status, targetVersion])

  const mandatory = Boolean(updateInfo?.mandatory)

  const handleDismiss = useCallback(() => {
    if (status === 'available' && targetVersion && !mandatory) {
      setDismissedVersion(targetVersion)
      return
    }
    if (status === 'error') {
      setDismissedErrorKey(errorKey)
    }
  }, [errorKey, mandatory, status, targetVersion])

  const handleDownload = useCallback(() => {
    void window.tabtin.updater.downloadUpdate()
  }, [])

  const handleInstall = useCallback(() => {
    window.tabtin.updater.quitAndInstall()
  }, [])

  const handleOpenUpdateSettings = useCallback(() => {
    openSettings({ category: 'device', section: 'about' })
  }, [openSettings])

  useEffect(() => {
    const unsubscribe = window.tabtin?.overlay?.onUpdatePromptAction?.((payload) => {
      const action = (payload as OverlayUpdatePromptActionPayload | undefined)?.action
      if (action === 'dismiss') {
        handleDismiss()
        return
      }
      if (action === 'open-settings') {
        handleOpenUpdateSettings()
        return
      }
      if (action === 'download') {
        handleDownload()
        return
      }
      if (action === 'install') {
        handleInstall()
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [handleDismiss, handleDownload, handleInstall, handleOpenUpdateSettings])

  const overlayOpen = visible && !(status === 'error' && dismissedErrorKey === errorKey)

  useEffect(() => {
    const overlay = window.tabtin?.overlay
    if (!overlay?.push) return

    if (overlayOpen) {
      pushedOpenRef.current = true
      void overlay.push({
        type: 'update-prompt',
        open: true,
        state: {
          currentVersion,
          status,
          downloadProgress,
          updateInfo,
          errorMessage,
        },
      })
      return
    }

    if (pushedOpenRef.current) {
      pushedOpenRef.current = false
      void overlay.push({ type: 'update-prompt', open: false })
    }
  }, [currentVersion, downloadProgress, errorMessage, overlayOpen, status, updateInfo])

  useEffect(() => {
    return () => {
      if (pushedOpenRef.current) {
        pushedOpenRef.current = false
        void window.tabtin?.overlay?.push?.({ type: 'update-prompt', open: false })
      }
    }
  }, [])

  return null
}
