import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, ExternalLink, Loader2 } from 'lucide-react'
import { Button, Dialog, DialogContent, DialogFooter, DialogTitle, Progress, toast } from '@components/ui'
import type { IMMessage } from '@/services/tabchatApi'
import { formatFileSize } from '@/services/tabchatAttachmentApi'
import { resolveImAttachmentDownloadUrl } from './openImFilePreview'
import { downloadImAttachment } from './downloadImAttachment'
import { OpenAIIcon } from './OpenAIIcon'

export const CodexSessionCard: React.FC<{ message: IMMessage; isMine: boolean }> = ({ message, isMine }) => {
  const { t } = useTranslation('tabchat')
  const importedSessionStorageKey = `tabtin:codex-session-import:${message.metadata?.message_ref || message.id}`
  const importedProjectStorageKey = `${importedSessionStorageKey}:project`
  const [importStage, setImportStage] = useState<'idle' | 'downloading' | 'importing'>('idle')
  const [progress, setProgress] = useState(0)
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projects, setProjects] = useState<Array<{ id: string; name: string; path: string }>>([])
  const [loadingProjects, setLoadingProjects] = useState(false)
  const [projectPath, setProjectPath] = useState(() => {
    try {
      return window.localStorage.getItem(importedProjectStorageKey) || ''
    } catch {
      return ''
    }
  })
  const [importedSessionId, setImportedSessionId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(importedSessionStorageKey)
    } catch {
      return null
    }
  })
  const importing = importStage !== 'idle'
  const card = message.metadata?.card
  const sessionId = typeof card?.codex_session_id === 'string' ? card.codex_session_id : ''
  const sessionName = typeof card?.codex_session_name === 'string'
    ? card.codex_session_name
    : message.metadata?.file_name || t('codexSessionShare.untitled', { defaultValue: '未命名会话' })
  const suggestedWorkingDirectory = typeof card?.suggested_working_directory === 'string'
    ? card.suggested_working_directory.trim()
    : ''

  useEffect(() => {
    if (!projectDialogOpen) return
    setLoadingProjects(true)
    void window.tabtin.codexSessionShare.projects()
      .then((localProjects) => {
        setProjects(localProjects)
        if (localProjects.length === 1) setProjectPath((current) => current || localProjects[0].path)
      })
      .catch((error) => {
        toast({
          title: t('codexSessionShare.loadProjectsFailed', {
            defaultValue: '读取 Codex Project 失败',
          }),
          description: error instanceof Error ? error.message : String(error),
          variant: 'destructive',
        })
      })
      .finally(() => setLoadingProjects(false))
  }, [projectDialogOpen, t])

  const handleImport = async (project: { id: string; path: string }) => {
    if (!sessionId || importing) return
    setImportStage('downloading')
    setProgress(10)
    try {
      const url = await resolveImAttachmentDownloadUrl(message, t)
      if (!url) return
      setProgress(25)
      const downloaded = await downloadImAttachment({
        url,
        fileName: message.metadata?.file_name || `${sessionName}.zip`,
        t,
      })
      if (downloaded.status !== 'saved' || !downloaded.path) {
        throw new Error(t('codexSessionShare.localPathRequired', {
          defaultValue: '会话文件已下载，但当前环境无法自动导入 Codex',
        }))
      }
      setImportStage('importing')
      setProgress(70)
      const result = await window.tabtin.codexSessionShare.import({
        filePath: downloaded.path,
        projectId: project.id,
        projectPath: project.path,
        expectedSessionId: sessionId,
        expectedSessionName: sessionName,
      })
      setImportedSessionId(result.sessionId)
      try {
        window.localStorage.setItem(importedSessionStorageKey, result.sessionId)
        window.localStorage.setItem(importedProjectStorageKey, project.path)
      } catch {
        // The current card still retains the imported ID for this render lifetime.
      }
      setProgress(100)
      toast({
        title: result.alreadyImported
          ? t('codexSessionShare.importedCopy', { defaultValue: '已作为副本导入并打开 Codex' })
          : t('codexSessionShare.imported', { defaultValue: '已导入并打开 Codex' }),
      })
    } catch (error) {
      toast({
        title: t('codexSessionShare.importFailed', { defaultValue: '导入 Codex 会话失败' }),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    } finally {
      setImportStage('idle')
      setProgress(0)
    }
  }

  const handleOpen = async (project: { id: string; path: string }) => {
    if (!importedSessionId) return
    try {
      await window.tabtin.codexSessionShare.open(importedSessionId, project.id, project.path)
    } catch (error) {
      toast({
        title: t('codexSessionShare.openFailed', { defaultValue: '无法在 Codex 中打开会话' }),
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    }
  }

  const handleConfirmProject = () => {
    const localProjectPath = projectPath.trim()
    if (!localProjectPath) return
    const project = projects.find((candidate) => candidate.path === localProjectPath)
    if (!project) return
    setProjectDialogOpen(false)
    void (importedSessionId ? handleOpen(project) : handleImport(project))
  }

  return (
    <div className="w-[320px] max-w-full overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex items-center gap-2 px-3.5 pt-3 text-caption font-medium text-accent">
        <OpenAIIcon className="h-3.5 w-3.5 rounded-sm" />
        <span className="line-clamp-2">{sessionName}</span>
      </div>
      <div className="px-3.5 py-3">
        <div className="text-caption text-muted-foreground">
          {t('codexSessionShare.cardTitle', { defaultValue: 'Codex 会话' })}
          {' · '}{formatFileSize(message.metadata?.file_size || 0)} · ZIP
        </div>
        {suggestedWorkingDirectory && (
          <div className="mt-2 break-all text-caption text-muted-foreground">
            {t('codexSessionShare.suggestedWorkingDirectoryLabel', {
              defaultValue: '建议工作目录：',
            })}
            {suggestedWorkingDirectory}
          </div>
        )}
      </div>
      {!isMine && <div className="border-t border-border/60 p-2.5">
        <button
          type="button"
          disabled={!sessionId || importing}
          onClick={() => setProjectDialogOpen(true)}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-interactive bg-accent px-3 py-2 text-body font-medium text-accent-foreground transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {importing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            : importedSessionId
              ? <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              : <Download className="h-3.5 w-3.5" aria-hidden />}
          {importedSessionId
            ? t('codexSessionShare.openInCodex', { defaultValue: '在 Codex 中打开' })
            : t('codexSessionShare.downloadAndImport', { defaultValue: '导入到 Codex' })}
        </button>
        {importing && (
          <div className="mt-2 space-y-1.5" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
              <span>
                {importStage === 'downloading'
                  ? t('codexSessionShare.downloading', { defaultValue: '正在下载会话文件…' })
                  : t('codexSessionShare.importing', { defaultValue: '正在导入并打开 Codex…' })}
              </span>
              <span>{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
        )}
      </div>}
      <Dialog open={projectDialogOpen} onOpenChange={(open) => { if (!importing) setProjectDialogOpen(open) }}>
        <DialogContent className="w-[460px] max-w-[calc(100vw-32px)] gap-0 overflow-hidden p-0">
          <div className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
            <OpenAIIcon className="h-4 w-4 rounded-sm" />
            <DialogTitle className="text-body font-medium">
              {t('codexSessionShare.chooseProject', { defaultValue: '选择 Codex Project' })}
            </DialogTitle>
          </div>
          <div className="space-y-2 px-4 py-4">
            <div className="text-caption text-muted-foreground">
              {t('codexSessionShare.chooseProjectHint', {
                defaultValue: '选择接收端 Codex 中已有的 Project，导入会话将归属到该 Project。',
              })}
            </div>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {loadingProjects ? (
                <div className="flex items-center gap-2 py-3 text-caption text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  {t('codexSessionShare.loadingProjects', { defaultValue: '正在读取 Codex Project…' })}
                </div>
              ) : projects.length > 0 ? projects.map((project) => (
                <button
                  key={project.path}
                  type="button"
                  onClick={() => setProjectPath(project.path)}
                  className={`w-full rounded-interactive border px-3 py-2 text-left transition-colors ${
                    projectPath === project.path
                      ? 'border-accent bg-accent/10'
                      : 'border-border/60 hover:bg-muted/50'
                  }`}
                >
                  <div className="text-body font-medium">{project.name}</div>
                </button>
              )) : (
                <div className="py-3 text-caption text-muted-foreground">
                  {t('codexSessionShare.noProjects', { defaultValue: '未发现本机 Codex Project' })}
                </div>
              )}
            </div>
          </div>
          <DialogFooter className="border-t border-border/60 px-4 py-3">
            <Button variant="ghost" onClick={() => setProjectDialogOpen(false)}>
              {t('common.cancel', { defaultValue: '取消' })}
            </Button>
            <Button disabled={!projectPath.trim()} onClick={handleConfirmProject}>
              {importedSessionId
                ? t('codexSessionShare.openInCodex', { defaultValue: '在 Codex 中打开' })
                : t('codexSessionShare.startImport', { defaultValue: '开始导入' })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
