/**
 * 下载列表行的共享组件和工具
 */

import React from 'react'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { useDownloadStore } from '@stores/useDownloadStore'
import i18n from '@/i18n'
import { ensureLegacyOk } from '@/services/legacy-result'

export const ROW_BTN = 'p-1.5 rounded-md hover:bg-muted text-muted-foreground transition-colors'
export const DOT = <span className="text-muted-foreground/40">·</span>

type ShellLegacyResult = { success?: boolean; error?: string; code?: string; message?: string }
type TabTinShell = {
  openPath?: (path: string) => Promise<ShellLegacyResult>
  showItemInFolder?: (path: string) => Promise<ShellLegacyResult>
}
const getTabtinShell = (): TabTinShell | undefined =>
  (window as { tabtin?: TabTinShell }).tabtin

async function runShellPathAction(
  action: keyof TabTinShell,
  filePath: string,
  title: string,
): Promise<void> {
  const api = getTabtinShell()?.[action]
  if (!api) {
    toast({ title, description: i18n.t('crawl:downloads.shellApiUnavailable', { defaultValue: '文件操作不可用' }), variant: 'destructive' })
    return
  }
  try {
    const result = await api(filePath)
    ensureLegacyOk(result, `shell:${action}`)
  } catch (error) {
    toast({
      title,
      description: error instanceof Error ? error.message : String(error),
      variant: 'destructive',
    })
  }
}

export const storeActions = {
  pause: (id: string) => useDownloadStore.getState().pause(id),
  resume: (id: string) => useDownloadStore.getState().resume(id),
  cancel: (id: string) => useDownloadStore.getState().cancel(id),
  cancelStream: (id: string) => useDownloadStore.getState().cancelStream(id),
  open: (id: string) => useDownloadStore.getState().open(id),
  showInFolder: (id: string) => useDownloadStore.getState().showInFolder(id),
  openPath: (filePath: string) =>
    runShellPathAction('openPath', filePath, i18n.t('crawl:downloads.openFileFailed', { defaultValue: '打开文件失败' })),
  showPathInFolder: (filePath: string) =>
    runShellPathAction('showItemInFolder', filePath, i18n.t('crawl:downloads.showInFolderFailed', { defaultValue: '在文件夹中显示失败' })),
  removeItem: (id: string) => useDownloadStore.getState().removeItem(id),
  retry: (id: string) => useDownloadStore.getState().retry(id),
  deleteFile: (id: string) => useDownloadStore.getState().deleteFile(id),
  removeStreamItem: (id: string) => useDownloadStore.getState().removeStreamItem(id),
  clearCompleted: () => useDownloadStore.getState().clearCompleted(),
}

interface DownloadRowShellProps {
  icon: React.ReactNode
  children: React.ReactNode
  actions: React.ReactNode
  actionsAlwaysVisible?: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

export const DownloadRowShell: React.FC<DownloadRowShellProps> = ({ icon, children, actions, actionsAlwaysVisible, onContextMenu }) => (
  <div
    className="group flex items-start gap-3 px-4 py-3 hover:bg-muted/60 rounded-lg transition-colors"
    onContextMenu={onContextMenu}
  >
    <div className="flex-shrink-0 mt-0.5">{icon}</div>
    <div className="flex-1 min-w-0">{children}</div>
    <div className={`flex-shrink-0 flex items-center gap-0.5 transition-opacity ${
      actionsAlwaysVisible ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
    }`}>
      {actions}
    </div>
  </div>
)
