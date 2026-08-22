import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { FolderOpen, Brain, Trash2 } from 'lucide-react'
import {
  Button,
  ScrollArea,
  toast,
} from '@components/ui'
import { useShallow } from 'zustand/react/shallow'
import { useSpaceStore } from '@stores/useSpaceStore'
import { ApprovalMemoApiService } from '@tabtin/app-shell'
import { useTranslation } from 'react-i18next'
import { SETTINGS_HINT, SETTINGS_SECTION_TITLE } from '@components/settings/settingsUi'
import { SpaceSettingsSectionHeader } from '@components/space-settings/SpaceSettingsSectionHeader'
import { notifyWorkspacePathsForSpace } from '@components/workspace/notifyWorkspacePaths'
import { cn } from '@utils/cn'
import { ApprovalGrantSection } from './ApprovalGrantSection'

interface AgentSecurityPanelProps {
  spaceId: string
  canManage?: boolean
  /** 审批档选择作用的目标会话；缺省时按 spaceId 回退到该 Space 当前会话。 */
  sessionId?: string | null
}

/**
 * 路径权限治理 Wave 1：workspace sources 分类展示子组件。
 *
 * 一个分类（sandbox / tabcode / tabfolder / attachments）一组：上方
 * 小标题（来源类型），下方路径列表（每条 truncate + title）。`paths`
 * 已由父组件保证非空数组，子组件本身不做空判定。
 *
 * Wave 6 / L53：``hint`` 给"无 Trash"分类用——sandbox / attachedFiles
 * 是产品决策不开放撤销（沙盒是 Agent 基础工作空间；附件随会话清理）。
 * 之前没有任何说明，用户对比 TabCode / TabFolder 的 Trash 按钮容易
 * 困惑「为什么这些路径删不掉」，hint 把"为什么"前置告诉用户。
 */
const WorkspaceSourceGroup: React.FC<{
  title: string
  paths: string[]
  hint?: string
  onRevokePath?: (path: string) => void
  revokeLabel?: string
  canManage?: boolean
}> = ({ title, paths, hint, onRevokePath, revokeLabel, canManage = true }) => (
  <div>
    <div className="text-caption text-muted-foreground/80 mb-1">{title}</div>
    {hint && (
      <p className="text-caption text-muted-foreground/60 mb-1 leading-snug">
        {hint}
      </p>
    )}
    <ul className="space-y-1">
      {paths.map((p) => (
        <li key={p} className="flex items-center gap-2 text-body text-foreground/80 pl-1 min-w-0" title={p}>
          <span className="min-w-0 flex-1 truncate">• {p}</span>
          {onRevokePath && canManage && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-1.5 text-muted-foreground/60 hover:text-destructive shrink-0"
              onClick={() => onRevokePath(p)}
              aria-label={revokeLabel}
              title={revokeLabel}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  </div>
)

export const AgentSecurityPanel: React.FC<AgentSecurityPanelProps> = ({ spaceId, canManage = true, sessionId = null }) => {
  const { t } = useTranslation('space')
  const { revokeApprovalMemoEntry, revokeAllApprovalMemos, isLoading } = useSpaceStore(
    useShallow((state) => ({
      revokeApprovalMemoEntry: state.revokeApprovalMemoEntry,
      revokeAllApprovalMemos: state.revokeAllApprovalMemos,
      isLoading: state.isLoading,
    })),
  )

  // 「已记住的授权」读 agent.agent_config.approval_memo（agentCache 快照）。
  // 打开面板时的强制刷新由 ApprovalGrantSection 挂载时统一执行——
  // 本面板必然渲染该区块，不重复拉。打开期间的实时刷新由全局
  // ApprovalMemoStoreSyncHost 统一驱动（主进程 commit 成功 / 远端广播 →
  // IPC → store loadAgent），本面板读 store 即实时。
  const saving = isLoading

  // 单根契约（见 docs/single-root-space-prd.md §2.1 / §2.2）：Agent 可访问的
  // 用户根 = sandbox + agent.working_dir。不再展示 TabCode 项目 / TabFolder 浏览
  // 目录两个分组——它们已废弃。本 panel 只读 main 端 workspace snapshot 的
  // sources.sandbox + sources.workingDir + sources.attachedFiles。
  const [sandboxPath, setSandboxPath] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [attachedFiles, setAttachedFiles] = useState<string[]>([])
  const [memoEntries, setMemoEntries] = useState<Array<{ key: string; description: string; allowed: boolean }>>([])

  useEffect(() => {
    if (!spaceId) return
    let cancelled = false
    // 修复 UI 数据流断链：AgentSecurityPanel 打开时主动 push 一次 hydrate。
    //
    // 原状只调 getWorkspaceSnapshot 被动读 main 当前快照——如果用户进入路径
    // 早于 setActiveSpace 触发的 hydrate（典型场景：侧边栏右键 Agent →
    // 设置 → 安全，不经过对话视图），main 端 sources.workingDir 从未被推过，
    // panel 拿到空快照触发"暂无可访问路径"空白态，与左侧 AgentProfilePane
    // 显示的 Agent.working_dir 矛盾。
    //
    // 修复：先 await notifyWorkspacePathsForSpace（从 useSpaceStore 读
    // agent.working_dir 推到 main），再 getWorkspaceSnapshot 拿合并后的
    // snapshot。两次 IPC 都在 useEffect 生命周期内 race-safe（cancelled 守卫）。
    const apply = (snapshot: any) => {
      if (cancelled) return
      setSandboxPath(typeof snapshot?.sources?.sandbox === 'string' ? snapshot.sources.sandbox : '')
      setWorkingDir(typeof snapshot?.sources?.workingDir === 'string' ? snapshot.sources.workingDir : '')
      setAttachedFiles(Array.isArray(snapshot?.sources?.attachedFiles)
        ? snapshot.sources.attachedFiles.filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
        : [])
    }
    notifyWorkspacePathsForSpace(spaceId)
      .catch(() => {
        // notify 失败不阻塞读 —— main 可能仍有上次 hydrate 的旧值可用，
        // 读出来仍比"空白态"准；失败原因 notify 内部已 console.warn
      })
      .then(() => window.tabtin?.agentSecurity?.getWorkspaceSnapshot?.(spaceId))
      .then(apply)
      .catch(() => {
        if (cancelled) return
        setSandboxPath('')
        setWorkingDir('')
        setAttachedFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [spaceId])

  const workspaceSources = useMemo(() => {
    const allowedPaths = Array.from(new Set([
      sandboxPath,
      workingDir,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0)))
    return {
      sandbox: sandboxPath,
      workingDir,
      attachedFiles,
      allowedPaths,
    }
  }, [attachedFiles, sandboxPath, workingDir])

  const hasAnyWorkspacePath =
    workspaceSources.sandbox.length > 0 ||
    workspaceSources.workingDir.length > 0 ||
    workspaceSources.attachedFiles.length > 0

  const refreshMemoEntries = useCallback(async () => {
    if (!spaceId) return
    try {
      const memo = await ApprovalMemoApiService.get(spaceId)
      setMemoEntries(
        Object.entries(memo.entries ?? {}).map(([key, entry]) => ({
          key,
          description: entry.scope_description || key,
          allowed: entry.decision !== 'deny',
        })),
      )
    } catch {
      setMemoEntries([])
    }
  }, [spaceId])

  useEffect(() => {
    void refreshMemoEntries()
    const handleChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail
      if (detail?.workspaceId === spaceId) void refreshMemoEntries()
    }
    window.addEventListener('tabtin:approval-memo-changed', handleChanged)
    return () => window.removeEventListener('tabtin:approval-memo-changed', handleChanged)
  }, [refreshMemoEntries, spaceId])

  const handleRevokeMemo = useCallback(async (entryKey: string) => {
    const ok = await revokeApprovalMemoEntry(spaceId, entryKey)
    if (!ok) {
      toast({ description: t('errors.updateFailed', { defaultValue: '操作失败' }), variant: 'destructive' })
      return
    }
    // 撤销只清了 Django + store 显示；主进程 runtime memoStore 缓存仍持有旧 entry
    // （Django 广播不回发发起端），不刷新会导致对话里 getAlways 仍命中、撤销不生效。
    await refreshMemoEntries()
    void window.tabtin?.agentEngine?.refreshApprovalMemo?.({ workspaceId: spaceId })
  }, [refreshMemoEntries, revokeApprovalMemoEntry, spaceId, t])

  const handleClearAllMemos = useCallback(async () => {
    // 走后端的 _revoke_all 单次请求，避免循环 DELETE 必撞 If-Match generation 冲突
    const ok = await revokeAllApprovalMemos(spaceId)
    if (!ok) {
      toast({ description: t('errors.updateFailed', { defaultValue: '操作失败' }), variant: 'destructive' })
      return
    }
    // 同 handleRevokeMemo：刷新主进程 runtime memoStore，让撤销在对话中即时生效。
    await refreshMemoEntries()
    void window.tabtin?.agentEngine?.refreshApprovalMemo?.({ workspaceId: spaceId })
  }, [refreshMemoEntries, revokeAllApprovalMemos, spaceId, t])

  return (
    <div className="flex flex-col h-full">
      <ScrollArea className="flex-1">
        <div className="space-y-5 pb-2">
          <SpaceSettingsSectionHeader
            marginBottomClassName="mb-1"
            title={t('security.title', { defaultValue: 'Agent 安全' })}
            description={t('security.infoDesc', { defaultValue: '控制 Agent 的执行权限和安全边界' })}
          />

          {/* A: 审批权限授权三档——当前对话的审批策略选择入口。
              选择规则 / 升档二次确认收敛在共享区块 ApprovalGrantSection
              （聊天 composer 的 ApprovalGrantPopover 复用同一实现）。 */}
          <ApprovalGrantSection spaceId={spaceId} canManage={canManage} sessionId={sessionId} />

          {/* B: 工作空间 Display — sources 分类展示（路径权限治理 Wave 1） */}
          <div className="border-t border-border/20 pt-4">
            <div className="flex items-center gap-2 mb-1.5">
              <FolderOpen className="h-3.5 w-3.5 text-muted-foreground/60" />
              <span className={SETTINGS_SECTION_TITLE}>
                {t('security.workspaceTitle', { defaultValue: 'Agent 当前可访问的路径' })}
              </span>
            </div>
            <p className={cn(SETTINGS_HINT, 'mb-3')}>
              {t('security.workspaceHint', { defaultValue: '由 Agent 沙盒 + Agent 工作目录组成，到 Agent 设置面板修改 working_dir 即可调整' })}
            </p>
            {hasAnyWorkspacePath ? (
              <div className="space-y-3">
                {workspaceSources.sandbox.length > 0 && (
                  <WorkspaceSourceGroup
                    title={t('security.workspaceSourceSandbox', { defaultValue: 'Agent 沙盒' })}
                    hint={t('security.workspaceSandboxHint', {
                      defaultValue: 'TabTin 为每个工作空间自动创建的基础工作空间，不在此处撤销',
                    })}
                    paths={[workspaceSources.sandbox]}
                  />
                )}
                {workspaceSources.workingDir.length > 0 && (
                  <WorkspaceSourceGroup
                    title={t('security.workspaceSourceWorkingDir', { defaultValue: 'Agent 工作目录' })}
                    hint={t('security.workspaceWorkingDirHint', {
                      defaultValue: 'Agent 在此目录上执行所有读写操作；要换目录请到 Agent 设置面板修改',
                    })}
                    paths={[workspaceSources.workingDir]}
                  />
                )}
                {workspaceSources.attachedFiles.length > 0 && (
                  <WorkspaceSourceGroup
                    title={t('security.workspaceSourceAttachments', { defaultValue: '附件' })}
                    hint={t('security.workspaceAttachmentsHint', {
                      defaultValue: '由你在对话中附加的文件自动登记，对话结束后自动失效；如需立即撤销，请删除对应的附件消息',
                    })}
                    paths={workspaceSources.attachedFiles}
                  />
                )}
                {/* P1-5：最终决策集 allowedPaths 总结块 ——
                    sources 是"用户感知的来源"，allowedPaths 是"Agent 实际能访问的目录"，
                    两者可能因过宽路径过滤而不一致；展示让用户清楚 Agent 真正能动哪里。 */}
                {workspaceSources.allowedPaths.length > 0 && (
                  <div className="rounded-md border border-border/30 bg-muted/10 px-3 py-2 mt-2">
                    <div className="text-caption font-medium text-foreground/80 mb-1">
                      {t('security.workspaceEffectiveTitle', { defaultValue: 'Agent 实际可访问的目录' })}
                    </div>
                    <p className={cn(SETTINGS_HINT, 'mb-2')}>
                      {t('security.workspaceEffectiveHint', {
                        defaultValue: '由上面的来源合并去重并过滤过宽路径后产生',
                      })}
                    </p>
                    <ul className="space-y-1">
                      {workspaceSources.allowedPaths.map((p) => (
                        <li
                          key={`effective-${p}`}
                          className="text-caption text-foreground/80 pl-1 truncate"
                          title={p}
                        >
                          • {p}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              // P1-6：空白态文案 actionable —— 告诉用户怎么"让 Agent 能访问"。
              // 重启 app（Wave 3 修复前）也会撞这个空白态，actionable 文案至少给出口。
              <p className="text-body text-muted-foreground/60">
                {t('security.workspaceEmpty', {
                  defaultValue: '暂无可访问路径，到 Agent 设置面板配置工作目录即可让 Agent 工作',
                })}
              </p>
            )}
          </div>

          {/* C: Remembered Approvals */}
          <div className="border-t border-border/20 pt-4">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <Brain className="h-3.5 w-3.5 text-muted-foreground/60" />
                <span className={SETTINGS_SECTION_TITLE}>
                  {t('security.memoTitle', { defaultValue: '已记住的授权' })}
                </span>
              </div>
              {memoEntries.length > 0 && canManage && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-caption text-destructive/80" onClick={handleClearAllMemos} disabled={saving}>
                  {t('security.memoClearAll', { defaultValue: '清空所有记忆' })}
                </Button>
              )}
            </div>
            {memoEntries.length > 0 ? (
              <div className="space-y-1">
                {memoEntries.map(entry => (
                  <div key={entry.key} className="flex items-center justify-between rounded-md px-3 py-1.5 hover:bg-muted/20 transition-colors">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={cn('text-caption font-medium', entry.allowed ? 'text-success' : 'text-destructive')}>
                        {entry.allowed ? '✓' : '✗'}
                      </span>
                      <span className="text-body text-foreground/80 truncate">{entry.description}</span>
                    </div>
                    {canManage && (
                      <Button variant="ghost" size="sm" className="h-6 px-2 text-caption text-muted-foreground/60 hover:text-destructive shrink-0" onClick={() => handleRevokeMemo(entry.key)} disabled={saving}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-body text-muted-foreground/60">
                {t('security.memoEmpty', { defaultValue: '暂无记忆，审批时选择"一直允许"后会出现在这里' })}
              </p>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
