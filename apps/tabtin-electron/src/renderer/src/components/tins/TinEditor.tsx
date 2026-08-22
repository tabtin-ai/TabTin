/**
 * TinEditor - Tin 代码编辑器
 *
 * 允许用户编辑 Tin 的各个文件：
 * - panel_html: UI 面板 HTML
 * - content_script: 页面注入脚本
 * - background_script: 后台脚本
 * - agent_instructions: Agent 指令
 */

import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { toast, ConfirmDialog } from '@tabtin/smartsheet-ui'
import { useTinsStore } from '../../stores/useTinsStore'
import { useOrganizationStore } from '../../stores/useOrganizationStore'
import { useSpaceStore } from '../../stores/useSpaceStore'
import * as tinsApi from '../../services/tinsApi'
import type { TinDefinition } from '../../services/tinsApi'
import {
  X,
  Save,
  Code,
  FileText,
  Bot,
  Loader2,
} from 'lucide-react'
import { cn } from '../../utils/cn'

type FileTab = 'panel_html' | 'content_script' | 'background_script' | 'agent_instructions'

const TAB_I18N_KEY: Record<FileTab, string> = {
  panel_html: 'editor.tabs.panelHtml',
  content_script: 'editor.tabs.contentScript',
  background_script: 'editor.tabs.backgroundScript',
  agent_instructions: 'editor.tabs.agentInstructions',
}

const FILE_TAB_KEYS: { key: FileTab; icon: React.ReactNode }[] = [
  { key: 'panel_html', icon: <Code className="w-3.5 h-3.5" /> },
  { key: 'content_script', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'background_script', icon: <FileText className="w-3.5 h-3.5" /> },
  { key: 'agent_instructions', icon: <Bot className="w-3.5 h-3.5" /> },
]

interface TinEditorProps {
  tinId: string
  onClose: () => void
}

export const TinEditor: React.FC<TinEditorProps> = ({ tinId, onClose }) => {
  const { t } = useTranslation('tins')
  const containerRef = useRef<HTMLDivElement>(null)
  const wsId = useOrganizationStore((s) => s.getEffectiveOrganizationId()) || ''
  const [tin, setTin] = useState<TinDefinition | null>(null)
  const [activeTab, setActiveTab] = useState<FileTab>('panel_html')
  const [editedContent, setEditedContent] = useState<Record<FileTab, string>>({
    panel_html: '',
    content_script: '',
    background_script: '',
    agent_instructions: '',
  })
  const [saving, setSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)

  const loadTin = useCallback(async () => {
    if (!wsId) return
    setLoadError(null)
    try {
      const detail = await tinsApi.getTin(wsId, tinId)
      setTin(detail)
      setEditedContent({
        panel_html: detail.panel_html || '',
        content_script: detail.content_script || '',
        background_script: detail.background_script || '',
        agent_instructions: detail.agent_instructions || '',
      })
    } catch (e) {
      console.error('[TinEditor] Failed to load tin:', e)
      setLoadError((e as Error).message || t('toast.loadFailed'))
    }
  }, [wsId, tinId, t])

  useEffect(() => { void loadTin() }, [loadTin])

  const handleContentChange = useCallback(
    (value: string) => {
      setEditedContent((prev) => ({
        ...prev,
        [activeTab]: value,
      }))
      setHasChanges(true)
    },
    [activeTab]
  )

  const handleSave = useCallback(async () => {
    if (!tin || !hasChanges || !wsId) return
    setSaving(true)
    try {
      await tinsApi.updateTinFile(wsId, tin.id, activeTab, editedContent[activeTab])
      setHasChanges(false)
      toast({ title: t('toast.saveSuccess') })

      useTinsStore.getState().loadTinDetail(tin.id)
      const spaceId = useSpaceStore.getState().selectedSpace?.id
      if (spaceId) {
        useTinsStore.getState().loadInstances(wsId, spaceId)
      }
    } catch (e) {
      console.error('[TinEditor] Failed to save:', e)
      toast({ title: t('toast.saveFailed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [tin, activeTab, editedContent, hasChanges, wsId, t])

  const handleSaveAll = useCallback(async () => {
    if (!tin || !wsId) return
    setSaving(true)
    try {
      for (const tab of FILE_TAB_KEYS) {
        const originalContent = tin[tab.key] || ''
        if (editedContent[tab.key] !== originalContent) {
          await tinsApi.updateTinFile(wsId, tin.id, tab.key, editedContent[tab.key])
        }
      }
      setHasChanges(false)
      toast({ title: t('toast.saveSuccess') })

      useTinsStore.getState().loadTinDetail(tin.id)
      const spaceId = useSpaceStore.getState().selectedSpace?.id
      if (spaceId) {
        useTinsStore.getState().loadInstances(wsId, spaceId)
      }
    } catch (e) {
      console.error('[TinEditor] Failed to save all:', e)
      toast({ title: t('toast.saveFailed'), variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }, [tin, editedContent, wsId, t])

  // Cmd+S / Ctrl+S 快捷保存（保存所有已修改的文件，与按钮行为一致）。
  // 仅当焦点位于本编辑器容器内时才接管，避免在侧边栏聊天框 / 其它面板按 Cmd+S
  // 时误触发 Tin 全量保存并吞掉用户本该生效的 Cmd+S。
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        const root = containerRef.current
        if (!root || !root.contains(document.activeElement)) return
        e.preventDefault()
        void handleSaveAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSaveAll])

  const handleClose = useCallback(() => {
    if (hasChanges) {
      setShowCloseConfirm(true)
      return
    }
    onClose()
  }, [hasChanges, onClose])

  if (!tin) {
    if (loadError) {
      return (
        <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
          <Code className="w-8 h-8 text-destructive opacity-60" />
          <p className="text-body text-destructive">{loadError}</p>
          <button
            onClick={() => void loadTin()}
            className="text-body px-3 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            {t('action.retry')}
          </button>
        </div>
      )
    }
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full bg-background">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <Code className="w-4 h-4 text-primary" />
        <span className="text-body font-medium truncate">{tin.name}</span>
        {hasChanges && (
          <span className="w-2 h-2 rounded-full bg-warning flex-shrink-0" />
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={handleSaveAll}
            disabled={!hasChanges || saving}
            className={cn(
              'flex items-center gap-1 px-2 py-1 rounded text-body',
              'bg-primary/10 text-primary hover:bg-primary/20',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              'transition-colors'
            )}
          >
            {saving ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Save className="w-3 h-3" />
            )}
            {t('action.saveAll')}
          </button>
          <button
            onClick={handleClose}
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 文件标签 */}
      <div className="flex border-b px-2">
        {FILE_TAB_KEYS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'flex items-center gap-1 px-3 py-1.5 text-body border-b-2 transition-colors',
              activeTab === tab.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab.icon}
            {t(TAB_I18N_KEY[tab.key])}
          </button>
        ))}
      </div>

      {/* 编辑区域 */}
      <div className="flex-1 overflow-hidden">
        <textarea
          value={editedContent[activeTab]}
          onChange={(e) => handleContentChange(e.target.value)}
          className={cn(
            'w-full h-full p-4 resize-none',
            'bg-muted/30 text-body font-mono',
            'focus:outline-none',
            'placeholder:text-muted-foreground/60'
          )}
          placeholder={t(`editor.placeholder.${
            activeTab === 'panel_html' ? 'panelHtml' :
            activeTab === 'content_script' ? 'contentScript' :
            activeTab === 'background_script' ? 'backgroundScript' : 'agentInstructions'
          }`)}
          spellCheck={false}
        />
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center gap-2 px-4 py-1.5 border-t text-body text-muted-foreground">
        <span>
          {activeTab === 'panel_html' && t('editor.lang.html')}
          {(activeTab === 'content_script' || activeTab === 'background_script') && t('editor.lang.javascript')}
          {activeTab === 'agent_instructions' && t('editor.lang.markdown')}
        </span>
        <span className="ml-auto">
          {t('editor.charCount', { count: editedContent[activeTab].length })}
        </span>
      </div>

      <ConfirmDialog
        open={showCloseConfirm}
        onOpenChange={setShowCloseConfirm}
        title={t('confirm.unsavedTitle')}
        description={t('confirm.unsavedChanges')}
        variant="default"
        onConfirm={onClose}
      />
    </div>
  )
}
