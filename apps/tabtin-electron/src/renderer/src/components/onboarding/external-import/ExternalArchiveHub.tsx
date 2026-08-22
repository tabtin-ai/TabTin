/**
 * 外部历史（兜底全屏页）。主入口在 Workspace 侧栏子组：点开即特殊新对话展开。
 * 本页仅作导入结果等深链兜底，列表点击同样直接开新对话。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Archive, MessageSquare } from 'lucide-react'
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { cn } from '@utils/cn'
import { ImportSourceIcon } from './ImportSourceIcon'
import { IMPORT_SOURCE_LABELS } from './useExternalImportDetection'
import { openExternalArchiveAsConversation } from './openExternalArchiveAsConversation'
import { useExternalArchiveFocusStore } from './useExternalArchiveFocusStore'
import type { ExternalArchiveIndexEntry } from './externalArchiveTypes'

function formatImportedAt(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  return new Date(t).toLocaleString()
}

export const ExternalArchiveHub: React.FC = () => {
  const organizationId = useOrganizationStore((s) => s.selectedOrganization?.id ?? null)
  const [entries, setEntries] = useState<ExternalArchiveIndexEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [openingKey, setOpeningKey] = useState<string | null>(null)
  const focus = useExternalArchiveFocusStore((s) => s.focus)

  useEffect(() => {
    if (!organizationId) {
      setEntries([])
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const api = window.tabtin?.import
        if (!api?.listArchives) {
          if (!cancelled) setError('当前客户端未暴露本机档案列表接口')
          return
        }
        const list = (await api.listArchives(organizationId)) as ExternalArchiveIndexEntry[]
        if (cancelled) return
        setEntries(
          [...(list ?? [])]
            .filter((e) => (e.messageCount ?? 0) > 0)
            .sort((a, b) => Date.parse(b.importedAt) - Date.parse(a.importedAt)),
        )
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [organizationId])

  // 深链：侧栏带 focus 时直接展开为新对话，不停留在列表页
  useEffect(() => {
    if (!organizationId || !focus) return
    const consumed = useExternalArchiveFocusStore.getState().consumeFocus()
    if (!consumed) return
    const key = `${consumed.source}:${consumed.sourceSessionId}`
    setOpeningKey(key)
    void openExternalArchiveAsConversation({
      organizationId,
      source: consumed.source,
      sourceSessionId: consumed.sourceSessionId,
    }).finally(() => setOpeningKey(null))
  }, [organizationId, focus])

  const handleOpen = useCallback(
    async (entry: ExternalArchiveIndexEntry) => {
      if (!organizationId) return
      const key = `${entry.source}:${entry.sourceSessionId}`
      setOpeningKey(key)
      try {
        await openExternalArchiveAsConversation({
          organizationId,
          source: entry.source,
          sourceSessionId: entry.sourceSessionId,
        })
      } finally {
        setOpeningKey(null)
      }
    },
    [organizationId],
  )

  if (!organizationId) {
    return (
      <StandaloneModulePage
        icon={<Archive className="h-7 w-7 text-amber-700" strokeWidth={1.75} aria-hidden />}
        title="外部历史"
        description="入口在对应工作空间下：点开即以特殊新对话展开。"
        testId="external-archive-hub"
      >
        <p className="text-caption text-muted-foreground/70">请先选择一个组织。</p>
      </StandaloneModulePage>
    )
  }

  return (
    <StandaloneModulePage
      icon={<Archive className="h-7 w-7 text-amber-700" strokeWidth={1.75} aria-hidden />}
      title="外部历史"
      description="主入口在对应工作空间下的「外部历史」。点开即以特殊新对话展开（注入全部消息），不是普通会话续写。"
      testId="external-archive-hub"
    >
      {loading && (
        <p className="px-1 py-6 text-caption text-muted-foreground/70">正在读取本机档案…</p>
      )}
      {error && (
        <div className="rounded-md bg-destructive/10 px-3 py-2 text-caption text-destructive">
          {error}
        </div>
      )}
      {!loading && !error && entries.length === 0 && (
        <div className="rounded-md border border-dashed border-border/70 px-4 py-8 text-center">
          <Archive className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" />
          <p className="text-body text-muted-foreground">还没有外部历史</p>
          <p className="mt-1 text-caption text-muted-foreground/70">
            从侧栏「导入数据」搬过来后，会出现在对应工作空间下。
          </p>
        </div>
      )}
      {!loading && !error && entries.length > 0 && (
        <ul
          className="divide-y divide-border/50 rounded-md border border-border/60"
          data-testid="external-archive-list"
        >
          {entries.map((entry) => {
            const key = `${entry.source}:${entry.sourceSessionId}`
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => void handleOpen(entry)}
                  disabled={openingKey === key || entry.messageCount === 0}
                  className={cn(
                    'flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
                    'hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                  data-testid="external-archive-row"
                >
                  <ImportSourceIcon
                    source={entry.source}
                    FallbackIcon={MessageSquare}
                    className="mt-0.5 h-5 w-5 shrink-0 rounded"
                    iconClassName="h-3.5 w-3.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-medium text-foreground">
                      {entry.title || '（无标题）'}
                    </div>
                    <div className="mt-0.5 truncate text-caption text-muted-foreground/80">
                      {IMPORT_SOURCE_LABELS[entry.source] ?? entry.source}
                      {' · '}
                      {entry.messageCount} 条消息
                      {entry.cwd ? ` · ${entry.cwd}` : ''}
                    </div>
                    <div className="mt-0.5 text-caption text-muted-foreground/60">
                      导入于 {formatImportedAt(entry.importedAt)}
                      {entry.messageCount === 0 ? ' · 无消息，无法打开' : ' · 点击打开新对话'}
                    </div>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </StandaloneModulePage>
  )
}
