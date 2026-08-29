import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiffMode } from './TabCodeDiffView'
import { TabCodePreview, type TabCodePreviewCache } from './TabCodePreview'
import {
  EDITOR_TAB_DRAG_TYPE,
  type EditorDropTarget,
  type EditorExtraTab,
  type EditorTabDragPayload,
  TabCodeEditorTabs,
} from './TabCodeEditorTabs'
import type { GitStatusMap } from './TabCodeFileTree'
import type { EditorFindRequest } from '@components/shared/file-preview/editorFindTypes'
import type { FilePreviewData } from '@components/shared/file-preview/types'
import type { TextEditorState } from '@components/shared/file-preview/TextFileEditor'
import { LayoutGroup, LayoutPanel, LayoutSeparator } from '@components/layout/resizable-v4'
import { cn } from '@utils/cn'
import type { LayoutNode, SplitSide } from '@/utils/split-layout'
import type { TabCodeEditorWorkspace } from '../utils/editorGroupLayout'
import { GitHistoryPane } from './git-history/GitHistoryPane'
import { relativePath } from '../utils/path'

export const GIT_HISTORY_TAB_ID = 'git-history'

interface TabCodeEditorGroupLayoutProps {
  rootPath: string
  /** 外层 Context 标签是否激活；保活 pane 隐藏时禁止 body portal 浮层残留。 */
  isPaneActive?: boolean
  workspace: TabCodeEditorWorkspace
  previewFilesByGroup?: Record<string, string>
  previewActiveByGroup?: Record<string, boolean>
  isGitRepo: boolean
  gitStatusRevision?: number
  gitContentRevisions?: Record<string, number>
  gitStatus: GitStatusMap
  selectedLine?: { line: number; ts: number }
  findRequest?: EditorFindRequest
  selectedGitDiffMode?: DiffMode
  onActivateGroup: (groupId: string) => void
  onActivateFile: (groupId: string, filePath: string) => void
  onActivatePreview: (groupId: string) => void
  onPinPreview: (groupId: string, filePath: string) => void
  onCloseFile: (groupId: string, filePath: string) => void
  onMoveFile: (
    sourceGroupId: string,
    targetGroupId: string,
    filePath: string,
    targetFilePath?: string | null,
    position?: 'before' | 'after',
  ) => void
  onReorderFile: (
    groupId: string,
    sourceFilePath: string,
    targetFilePath: string,
    position: 'before' | 'after',
  ) => void
  onSplitFile: (sourceGroupId: string, targetGroupId: string, filePath: string, side: SplitSide) => void
  onSplitResize: (path: number[], sizes: number[]) => void
  onFileSaved: () => void
  editorSessionKey: string
  onEditorStateChange: (
    sessionKey: string,
    groupId: string,
    filePath: string,
    state: TextEditorState | null,
  ) => void
  onFileDeleted: (filePath: string) => void
  onClearPreview: (groupId: string) => void
  gitHistoryOpen?: boolean
  gitHistoryActive?: boolean
  gitHistoryGroupId?: string | null
  gitHistoryLabel?: string
  gitHistoryRefreshToken?: number
  onActivateGitHistory?: () => void
  onCloseGitHistory?: () => void
  onMoveGitHistory?: (sourceGroupId: string, targetGroupId: string) => void
  onSplitGitHistory?: (sourceGroupId: string, targetGroupId: string, side: SplitSide) => void
}

function resolveDropSide(event: React.DragEvent<HTMLElement>): SplitSide | 'center' {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = (event.clientX - rect.left) / rect.width
  const y = (event.clientY - rect.top) / rect.height
  const edgeSize = 0.25
  const distances: Array<[SplitSide, number]> = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y],
  ]
  const [side, distance] = distances.reduce((closest, candidate) => (
    candidate[1] < closest[1] ? candidate : closest
  ))
  return distance < edgeSize ? side : 'center'
}

function parseDragPayload(event: React.DragEvent): EditorTabDragPayload | null {
  const raw = event.dataTransfer.getData(EDITOR_TAB_DRAG_TYPE)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as EditorTabDragPayload
    return parsed.sourceGroupId && parsed.filePath ? parsed : null
  } catch {
    return null
  }
}

function normalizeSizes(values: number[]): number[] | null {
  if (values.length === 0 || values.some((value) => value <= 0)) return null
  const total = values.reduce((sum, value) => sum + value, 0)
  return total > 0 ? values.map((value) => value / total) : null
}

export function TabCodeEditorGroupLayout({
  rootPath,
  isPaneActive = true,
  workspace,
  previewFilesByGroup = {},
  previewActiveByGroup = {},
  isGitRepo,
  gitStatusRevision = 0,
  gitContentRevisions = {},
  gitStatus,
  selectedLine,
  findRequest,
  selectedGitDiffMode,
  onActivateGroup,
  onActivateFile,
  onActivatePreview,
  onPinPreview,
  onCloseFile,
  onMoveFile,
  onReorderFile,
  onSplitFile,
  onSplitResize,
  onFileSaved,
  editorSessionKey,
  onEditorStateChange,
  onFileDeleted,
  onClearPreview,
  gitHistoryOpen = false,
  gitHistoryActive = false,
  gitHistoryGroupId = null,
  gitHistoryLabel,
  gitHistoryRefreshToken = 0,
  onActivateGitHistory,
  onCloseGitHistory,
  onMoveGitHistory,
  onSplitGitHistory,
}: TabCodeEditorGroupLayoutProps): React.ReactElement {
  const { t } = useTranslation('tabcode')
  const [draggedTab, setDraggedTab] = useState<EditorTabDragPayload | null>(null)
  const [dropTarget, setDropTarget] = useState<EditorDropTarget | null>(null)
  // 预览缓存属于工作区布局，而不是某个编辑器组。文件跨组移动时，目标组可立即
  // 复用已读内容，避免把一次简单的拖放变成“清空 → 重新读文件 → 重建编辑器”。
  const previewCacheRef = useRef<TabCodePreviewCache>(new Map())
  const previewPreloadRef = useRef(new Set<string>())

  // 活跃标签由 TabCodePreview 自己加载；其余已打开标签在后台预热。这样跨组移动
  // 当前标签后，源组回退到下一个标签无需经历“空白 → IPC 读盘 → 编辑器重建”。
  useEffect(() => {
    const inactiveOpenFiles = Object.values(workspace.groupsById).flatMap((group) => (
      group.openFiles.filter((filePath) => filePath !== group.activeFile)
    ))
    for (const filePath of inactiveOpenFiles) {
      if (previewCacheRef.current.has(filePath) || previewPreloadRef.current.has(filePath)) continue
      previewPreloadRef.current.add(filePath)
      window.tabtin.fileSystem.readFilePreview(filePath, { maxBytes: 512 * 1024 })
        .then((result: { data?: FilePreviewData } | null) => {
          const data = result?.data
          previewCacheRef.current.set(filePath, {
            content: data?.kind === 'text' ? (data.content || '') : '',
            kind: data?.kind ?? null,
          })
        })
        .catch(() => {
          // 失效文件仍由活跃预览的 watch/delete 链路裁剪，预热不制造用户可见错误。
        })
        .finally(() => {
          previewPreloadRef.current.delete(filePath)
        })
    }
  }, [workspace.groupsById])

  const handleTabDragStart = useCallback((
    event: React.DragEvent,
    sourceGroupId: string,
    filePath: string,
  ) => {
    const tabWidth = event.currentTarget.getBoundingClientRect().width
    event.dataTransfer.setData(EDITOR_TAB_DRAG_TYPE, JSON.stringify({ sourceGroupId, filePath, tabWidth }))
    event.dataTransfer.effectAllowed = 'move'
    setDraggedTab({ sourceGroupId, filePath, tabWidth })
  }, [])

  const clearDragState = useCallback(() => {
    setDraggedTab(null)
    setDropTarget(null)
  }, [])

  const renderGroup = useCallback((groupId: string) => {
    const group = workspace.groupsById[groupId]
    if (!group) {
      return <div className="h-full w-full bg-destructive/5" />
    }
    const isActiveGroup = workspace.activeGroupId === groupId
    const isBodyDropTarget = dropTarget?.groupId === groupId && dropTarget.zone === 'editor-body'
      ? dropTarget.side
      : null
    const previewFile = previewFilesByGroup[groupId] ?? null
    const isPreviewActive = Boolean(previewFile && previewActiveByGroup[groupId])
    const displayFile = isPreviewActive ? previewFile : group.activeFile
    const showHistoryTab = gitHistoryOpen && gitHistoryGroupId === groupId
    const historyActive = showHistoryTab && gitHistoryActive
    const extraTabs: EditorExtraTab[] = showHistoryTab
      ? [{ id: GIT_HISTORY_TAB_ID, label: gitHistoryLabel || t('editorTabs.gitHistory') }]
      : []

    return (
      <div
        className={cn(
          'relative flex h-full min-h-0 min-w-0 flex-col bg-background',
          'border border-transparent',
          isActiveGroup ? 'ring-1 ring-inset ring-primary/30' : 'border-border/30',
        )}
        data-editor-group-id={groupId}
        onPointerDownCapture={() => onActivateGroup(groupId)}
      >
        <TabCodeEditorTabs
          rootPath={rootPath}
          groupId={groupId}
          openFiles={group.openFiles}
          previewFile={previewFile}
          isPreviewActive={isPreviewActive}
          activeFile={group.activeFile}
          isGroupActive={isActiveGroup}
          onActivate={(filePath) => onActivateFile(groupId, filePath)}
          onActivatePreview={() => onActivatePreview(groupId)}
          onPinPreview={(filePath) => onPinPreview(groupId, filePath)}
          onClose={(filePath) => onCloseFile(groupId, filePath)}
          onClearPreview={() => onClearPreview(groupId)}
          onDragStart={handleTabDragStart}
          onDragEnd={clearDragState}
          draggedTab={draggedTab}
          dropTarget={dropTarget}
          onDropTargetChange={setDropTarget}
          onReorder={(sourceFilePath, targetFilePath, position) => {
            if (sourceFilePath === GIT_HISTORY_TAB_ID) return
            onReorderFile(groupId, sourceFilePath, targetFilePath, position)
          }}
          onMoveHere={(sourceGroupId, filePath, targetFilePath, position) => {
            if (filePath === GIT_HISTORY_TAB_ID) {
              onMoveGitHistory?.(sourceGroupId, groupId)
              return
            }
            onMoveFile(sourceGroupId, groupId, filePath, targetFilePath, position)
          }}
          extraTabs={extraTabs}
          activeExtraTabId={historyActive ? GIT_HISTORY_TAB_ID : null}
          onActivateExtraTab={() => onActivateGitHistory?.()}
          onCloseExtraTab={() => onCloseGitHistory?.()}
        />
        <div className="min-h-0 flex-1">
          {(() => {
            const applyBodyDrop = (payload: EditorTabDragPayload, side: SplitSide | 'center') => {
              if (payload.filePath === GIT_HISTORY_TAB_ID) {
                if (side === 'center') onMoveGitHistory?.(payload.sourceGroupId, groupId)
                else onSplitGitHistory?.(payload.sourceGroupId, groupId, side)
                return
              }
              if (side === 'center') onMoveFile(payload.sourceGroupId, groupId, payload.filePath)
              else onSplitFile(payload.sourceGroupId, groupId, payload.filePath, side)
            }
            const contentDropProps = {
              'data-editor-content-dropzone': groupId,
              onDragOver: (event: React.DragEvent<HTMLElement>) => {
                if (!Array.from(event.dataTransfer.types).includes(EDITOR_TAB_DRAG_TYPE)) return
                const payload = draggedTab ?? parseDragPayload(event)
                if (payload?.filePath === displayFile) {
                  setDropTarget(null)
                  return
                }
                event.preventDefault()
                event.dataTransfer.dropEffect = 'move'
                setDropTarget({ groupId, zone: 'editor-body', side: resolveDropSide(event) })
              },
              onDragLeave: (event: React.DragEvent<HTMLElement>) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setDropTarget((current) => (
                    current?.groupId === groupId && current.zone === 'editor-body' ? null : current
                  ))
                }
              },
              onDrop: (event: React.DragEvent<HTMLElement>) => {
                const payload = parseDragPayload(event)
                if (!payload) return
                if (payload.filePath === displayFile) {
                  clearDragState()
                  return
                }
                event.preventDefault()
                const side = resolveDropSide(event)
                clearDragState()
                applyBodyDrop(payload, side)
              },
            }
            const dropOverlay = isBodyDropTarget ? (
              <div
                data-editor-body-drop={isBodyDropTarget}
                className={cn(
                  'pointer-events-none absolute z-sticky flex items-center justify-center border border-primary/75 bg-primary/15 text-caption font-medium text-primary',
                  isBodyDropTarget === 'center' && 'inset-2 rounded-md',
                  isBodyDropTarget === 'left' && 'inset-y-2 left-2 w-[24%] rounded-l-md',
                  isBodyDropTarget === 'right' && 'inset-y-2 right-2 w-[24%] rounded-r-md',
                  isBodyDropTarget === 'top' && 'inset-x-2 top-2 h-[24%] rounded-t-md',
                  isBodyDropTarget === 'bottom' && 'inset-x-2 bottom-2 h-[24%] rounded-b-md',
                )}
              >
                {isBodyDropTarget === 'center'
                  ? t('editorTabs.moveHere')
                  : t(`editorTabs.split${isBodyDropTarget.charAt(0).toUpperCase()}${isBodyDropTarget.slice(1)}`)}
              </div>
            ) : null

            if (historyActive) {
              return (
                <div
                  className="relative h-full min-h-0"
                  {...contentDropProps}
                >
                  <GitHistoryPane
                    rootPath={rootPath}
                    refreshToken={gitHistoryRefreshToken}
                    isPaneActive={isPaneActive}
                  />
                  {dropOverlay}
                </div>
              )
            }

            return (
              <TabCodePreview
                rootPath={rootPath}
                isPaneActive={isPaneActive}
                editorSessionKey={editorSessionKey}
                editorGroupId={groupId}
                filePath={displayFile}
                isPinned
                initialLine={isActiveGroup ? selectedLine?.line : undefined}
                initialLineKey={isActiveGroup ? selectedLine?.ts : undefined}
                findRequest={isActiveGroup ? findRequest : undefined}
                isGitRepo={isGitRepo}
                gitStatusRevision={gitStatusRevision}
                gitContentRevision={displayFile
                  ? (gitContentRevisions[relativePath(rootPath, displayFile)] ?? 0)
                  : 0}
                viewMode="all"
                gitDiffMode={isActiveGroup ? selectedGitDiffMode : undefined}
                fileGitStatus={displayFile ? (gitStatus.get(displayFile) ?? null) : null}
                onClose={() => {
                  if (isPreviewActive) onClearPreview(groupId)
                  else if (group.activeFile) onCloseFile(groupId, group.activeFile)
                }}
                onFileSaved={onFileSaved}
                onEditorStateChange={onEditorStateChange}
                onFileDeleted={() => {
                  if (isPreviewActive) onClearPreview(groupId)
                  if (displayFile) onFileDeleted(displayFile)
                }}
                contentDropProps={contentDropProps}
                contentOverlay={dropOverlay}
                previewCache={previewCacheRef.current}
                preserveEditorOnFileChange
              />
            )
          })()}
        </div>
      </div>
    )
  }, [
    workspace,
    isPaneActive,
    previewFilesByGroup,
    previewActiveByGroup,
    draggedTab,
    dropTarget,
    rootPath,
    isGitRepo,
    gitStatusRevision,
    gitContentRevisions,
    gitStatus,
    selectedLine,
    findRequest,
    selectedGitDiffMode,
    onActivateGroup,
    onActivateFile,
    onActivatePreview,
    onPinPreview,
    onCloseFile,
    onMoveFile,
    onReorderFile,
    onSplitFile,
    onFileSaved,
    editorSessionKey,
    onEditorStateChange,
    onFileDeleted,
    onClearPreview,
    handleTabDragStart,
    clearDragState,
    gitHistoryOpen,
    gitHistoryActive,
    gitHistoryGroupId,
    gitHistoryLabel,
    gitHistoryRefreshToken,
    onActivateGitHistory,
    onCloseGitHistory,
    onMoveGitHistory,
    onSplitGitHistory,
    t,
  ])

  const renderNode = useCallback((node: LayoutNode, path: number[]): React.ReactNode => {
    if (node.type === 'leaf') return renderGroup(node.paneId)
    const isHorizontal = node.direction === 'horizontal'
    const panelIds = node.children.map((child, index) => (
      `tabcode-editor-${node.id}-${path.join('-') || 'root'}-${index}-${child.type === 'leaf' ? child.paneId : child.id}`
    ))

    return (
      <LayoutGroup
        id={`tabcode-editor-split-${node.id}`}
        orientation={isHorizontal ? 'horizontal' : 'vertical'}
        className={cn('h-full w-full', isHorizontal ? 'flex-row' : 'flex-col')}
        onLayoutChanged={(layoutData: unknown) => {
          if (!layoutData || typeof layoutData !== 'object' || Array.isArray(layoutData)) return
          const layoutMap = layoutData as Record<string, number>
          const sizes = normalizeSizes(panelIds.map((panelId) => (layoutMap[panelId] ?? 0) / 100))
          if (sizes) onSplitResize(path, sizes)
        }}
      >
        {node.children.map((child, index) => (
          <React.Fragment key={child.type === 'leaf' ? child.paneId : child.id}>
            <LayoutPanel
              id={panelIds[index]}
              defaultSize={`${(node.sizes[index] ?? 1 / node.children.length) * 100}%`}
              minSize="20%"
              className="min-h-0 min-w-0 overflow-hidden"
            >
              {renderNode(child, [...path, index])}
            </LayoutPanel>
            {index < node.children.length - 1 && (
              <LayoutSeparator
                className={cn(
                  'group/handle bg-border/20 transition-colors hover:bg-primary/30',
                  isHorizontal ? '!w-1.5 cursor-col-resize' : '!h-1.5 cursor-row-resize',
                )}
              />
            )}
          </React.Fragment>
        ))}
      </LayoutGroup>
    )
  }, [onSplitResize, renderGroup])

  const renderedLayout = useMemo(
    () => renderNode(workspace.layout, []),
    [workspace.layout, renderNode],
  )

  return <div className="h-full w-full">{renderedLayout}</div>
}
