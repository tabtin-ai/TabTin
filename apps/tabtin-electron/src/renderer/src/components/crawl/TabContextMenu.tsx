import React, { useState, useCallback, useRef, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, Input, Button, Label } from '@tabtin/smartsheet-ui'
import type { CrawlTab } from '@stores/useCrawlTabStore'
import { useShallow } from 'zustand/react/shallow'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { openNativeContextMenu, menuSeparator, type NativeMenuItem } from '@/utils/nativeMenu'
import { requestCloseWorkspace } from '@tabtin/crawlspace-core'
import { electronCrawlspaceHost } from '../../crawlspace/host/electron-crawlspace-host'
import { useTranslation } from 'react-i18next'

interface TabContextMenuProps {
  tab: CrawlTab
  children: React.ReactNode
}

export const TabContextMenu: React.FC<TabContextMenuProps> = ({ tab, children }) => {
  const { t } = useTranslation('crawl')
  const { updateTab, deleteTab } = useCrawlTabStore(useShallow((s) => ({
    updateTab: s.updateTab,
    deleteTab: s.deleteTab,
  })))
  const isWorkspaceTab = tab.kind === 'workspace'
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [newName, setNewName] = useState(tab.name)

  // 保存清理函数的引用
  const cleanupRef = useRef<(() => void) | null>(null)

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      cleanupRef.current?.()
    }
  }, [])

  // 重命名标签
  const handleRename = useCallback(() => {
    setNewName(tab.name)
    setRenameDialogOpen(true)
  }, [tab.name])

  const handleRenameSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (newName.trim()) {
      updateTab(tab.id, { name: newName.trim() })
      setRenameDialogOpen(false)
    }
  }

  // 删除标签
  const handleDelete = useCallback(() => {
    if (isWorkspaceTab) {
      const handled = requestCloseWorkspace({
        crawlspaceId: tab.id,
        reason: 'context-menu.delete'
      })
      if (!handled) {
        void electronCrawlspaceHost.closeWorkspaceUI?.({
          crawlspaceId: tab.id,
          reason: 'user-close-tab',
        })
      }
      return
    }
    deleteTab(tab.id)
  }, [isWorkspaceTab, tab.id, deleteTab])

  // 🆕 使用原生菜单（不会被 WebContentsView 遮挡）
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // 清理之前的菜单
    cleanupRef.current?.()

    // 构建菜单项
    const items: NativeMenuItem[] = [
      {
        id: 'rename',
        label: t('tabContextMenu.rename'),
        onClick: handleRename
      },
      menuSeparator(),
      {
        id: 'delete',
        label: t('tabContextMenu.delete'),
        onClick: handleDelete
      }
    ]

    // 打开原生菜单
    cleanupRef.current = openNativeContextMenu(items, e.clientX, e.clientY)
  }, [handleRename, handleDelete, t])

  return (
    <>
      <div onContextMenu={handleContextMenu}>
        {children}
      </div>

      {/* 重命名对话框 */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('tabContextMenu.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('tabContextMenu.dialogDescription')}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRenameSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rename">{t('tabContextMenu.newNameLabel')}</Label>
              <Input
                id="rename"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('tabContextMenu.newNamePlaceholder')}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setRenameDialogOpen(false)}
              >
                {t('tabContextMenu.cancel')}
              </Button>
              <Button type="submit">
                {t('tabContextMenu.confirm')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
