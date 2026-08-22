/**
 * NewSpaceButton - 侧边栏「新建 Space」按钮
 *
 * 点击直接进入新建 Space 流程（选目录 → 配置执行内核）。
 * 会话发起入口不放在 Space 列表上下文：私聊由通讯录成员入口发起，群聊在消息侧栏发起，
 * 避免把两种产品概念混在同一个弹出菜单里。
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Plus,
  FolderPlus,
  Folder,
  Code2,
  FileText,
  Loader2,
  X,
  Settings2,
  Info,
  Server,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogScrollBody,
  Input,
  Textarea,
  Button as UIButton,
  toast,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@components/ui'
import { useTranslation } from 'react-i18next'
import type { UpdateAgentRequest } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import {
  useSpaceAgentDialogStore,
  type DaemonWorkspaceCreateTarget,
} from '@stores/useSpaceAgentDialogStore'
import { notifyWorkspacePathsForSpace } from '@components/workspace/notifyWorkspacePaths'
import { ContextDialogHeader } from '@components/context-space/ContextDialogHeader'
import { cn } from '@utils/cn'
import { resolveRealPath } from '@utils/canonicalPath'
import { openCreatedWorkspaceAsNewTask } from '@/services/newTaskDraftNavigation'
import {
  findLocalWorkingDirConflict,
  getSelectedWorkingDirCreateBlocker,
  handleWorkingDirConflictResponse,
  isWorkingDirConflictError,
} from '@components/space-settings/profile/workingDirConflict'
import { generateRandomWorkspaceName } from './generateRandomWorkspaceName'
import { createLogger } from '@/utils/logger'

const log = createLogger('CreateWorkspaceDialog')

interface NewSpaceButtonProps {
  variant?: 'full' | 'icon'
  className?: string
  onCreateSpace?: () => void
}

type WorkingDirType = 'code' | 'mixed' | 'doc'

// path 解析为 basename（最后一段非空目录名）。
// 兼容 Windows 反斜杠和 POSIX 正斜杠，trim 尾部分隔符。
function getBasename(path: string): string {
  if (!path) return ''
  const trimmed = path.replace(/[\\/]+$/, '')
  const segments = trimmed.split(/[\\/]/)
  return segments[segments.length - 1] || ''
}

export function isValidRemoteWorkingDir(value: string): boolean {
  const path = value.trim()
  if (!path || path.includes('\0') || path.length > 4096) return false
  const hasNonRootSegment = (segments: string[]): boolean => {
    const normalized: string[] = []
    for (const segment of segments) {
      if (!segment || segment === '.') continue
      if (segment === '..') normalized.pop()
      else normalized.push(segment)
    }
    return normalized.length > 0
  }
  if (path.startsWith('/')) return hasNonRootSegment(path.split('/'))
  if (/^[A-Za-z]:[\\/]\S/.test(path)) {
    return hasNonRootSegment(path.slice(3).split(/[\\/]+/))
  }
  if (path.startsWith('\\\\')) {
    const parts = path.split(/[\\/]+/).filter(Boolean)
    return parts.length >= 2 && hasNonRootSegment(parts.slice(2))
  }
  return false
}

/**
 * 共享的 Space 创建流程：直接打开 CreateSpaceDialog。
 *
 * Space 是 Team + Device + working_dir 下的执行现场。工作目录可选——不选时
 * 在当前团队目录下自动创建；名称可选——未填且未选目录时随机生成。
 *
 * NewSpaceButton 和 WelcomePage（欢迎页空状态「创建第一个 Space」）共用它，
 * 保证两条创建路径一致。
 */
export function useCreateSpaceFlow(): {
  isCreateSpaceOpen: boolean
  setIsCreateSpaceOpen: (open: boolean) => void
  triggerCreate: () => void
} {
  const isCreateSpaceOpen = useSpaceAgentDialogStore(
    (s) => s.isOpen && s.mode === 'create',
  )
  const openCreate = useSpaceAgentDialogStore((s) => s.openCreate)
  const close = useSpaceAgentDialogStore((s) => s.close)

  const setIsCreateSpaceOpen = useCallback(
    (open: boolean) => {
      if (open) {
        openCreate()
      } else {
        close()
      }
    },
    [openCreate, close],
  )

  const triggerCreate = useCallback(() => {
    openCreate()
  }, [openCreate])

  return { isCreateSpaceOpen, setIsCreateSpaceOpen, triggerCreate }
}

export const NewSpaceButton: React.FC<NewSpaceButtonProps> = ({
  variant: _variant = 'icon',
  className,
  onCreateSpace,
}) => {
  const { t } = useTranslation(['sidebar', 'space'])
  const triggerCreate = useSpaceAgentDialogStore((s) => s.openCreate)

  const handleClick = () => {
    if (onCreateSpace) {
      onCreateSpace()
      return
    }
    triggerCreate()
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'h-6 w-6 rounded-md text-muted-foreground/80 hover:text-foreground hover:bg-accent/10 transition-colors flex items-center justify-center',
        className,
      )}
      title={t('sidebar:tooltips.newAgent', { defaultValue: '新建 Space' })}
      aria-label={t('sidebar:tooltips.newAgent', {
        defaultValue: '新建 Space',
      })}
    >
      <Plus className="h-4 w-4" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// CreateSpaceDialog — 创建 / 编辑 Space（同一套表单）
// ---------------------------------------------------------------------------

function resolveWorkingDirType(
  type: string | null | undefined,
): WorkingDirType {
  if (type === 'code' || type === 'mixed' || type === 'doc') return type
  return 'mixed'
}

function resolveCreateOrganizationId(): string | null {
  const wt = useOrganizationStore.getState().selectedOrganization
  const list = useOrganizationStore.getState().organizations
  return wt?.id ?? list[0]?.id ?? null
}

function resolveCreateOrganizationName(organizationId: string): string {
  const wt = useOrganizationStore.getState().selectedOrganization
  if (wt?.id === organizationId) return wt.name
  return (
    useOrganizationStore
      .getState()
      .organizations.find((item) => item.id === organizationId)?.name ?? ''
  )
}

function FieldHintTooltip({
  label,
  content,
}: {
  label: string
  content: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60"
          aria-label={label}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        align="start"
        className="max-w-[260px] leading-relaxed"
      >
        {content}
      </TooltipContent>
    </Tooltip>
  )
}

export interface CreateSpaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mode?: 'create' | 'edit'
  spaceId?: string | null
  daemonTarget?: DaemonWorkspaceCreateTarget | null
}

const CreateSpaceDialog: React.FC<CreateSpaceDialogProps> = ({
  open,
  onOpenChange,
  mode = 'create',
  spaceId = null,
  daemonTarget = null,
}) => {
  const { t } = useTranslation(['space', 'common'])
  const isEditMode = mode === 'edit' && Boolean(spaceId)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [customRules, setCustomRules] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [workingDir, setWorkingDir] = useState('')
  const [workingDirType, setWorkingDirType] = useState<WorkingDirType>('mixed')
  const [isPickingDir, setIsPickingDir] = useState(false)
  // ：冲突/失败要在对话框内可见；仅靠顶部 toast 容易被 Dialog 挡住或 2s 闪过。
  const [formError, setFormError] = useState<string | null>(null)
  /** 编辑态：打开时已有工作目录则锁定路径，只允许改类型（与设置页一致）。 */
  const [pathLocked, setPathLocked] = useState(false)
  const createSpace = useSpaceStore((state) => state.createSpace)
  const updateSpace = useSpaceStore((state) => state.updateSpace)
  const updateAgent = useSpaceStore((state) => state.updateAgent)
  const loadAgent = useSpaceStore((state) => state.loadAgent)
  const refreshSpace = useSpaceStore((state) => state.refreshSpace)

  const applyAgentFields = useCallback(
    (agent: {
      custom_rules?: string | null
    }) => {
      setCustomRules(agent.custom_rules ?? '')
    },
    [],
  )

  useEffect(() => {
    if (!open) {
      setIsPickingDir(false)
      setFormError(null)
      setPathLocked(false)
      return
    }

    setFormError(null)

    if (isEditMode && spaceId) {
      const spaceState = useSpaceStore.getState()
      const space = spaceState.spaces.find((s) => s.id === spaceId)
      //  / ：人设跟当前选中身份，现场不再投影 Agent
      const selectedAgent = spaceState.selectedAgent
      const agentId = selectedAgent?.id ?? null
      const cachedAgent = agentId
        ? spaceState.agentCache[agentId] ?? selectedAgent
        : null

      if (space) {
        setName(space.name)
        setDescription(space.description ?? '')
        setCustomRules(cachedAgent?.custom_rules ?? '')
        setWorkingDir(space.working_dir ?? '')
        setWorkingDirType(resolveWorkingDirType(space.working_dir_type))
        setPathLocked(Boolean(space.working_dir?.trim()))
      } else {
        setName('')
        setDescription('')
        setCustomRules('')
        setWorkingDir('')
        setWorkingDirType('mixed')
        setPathLocked(false)
      }

      if (cachedAgent) {
        applyAgentFields(cachedAgent)
      }

      if (agentId) {
        void loadAgent(agentId, { force: true }).then((agent) => {
          if (
            agent &&
            useSpaceAgentDialogStore.getState().isOpen &&
            useSpaceAgentDialogStore.getState().spaceId === spaceId
          ) {
            applyAgentFields(agent)
          }
        })
      }
      return
    }

    setName('')
    setDescription('')
    setCustomRules('')
    setWorkingDir('')
    setWorkingDirType('mixed')
    setIsPickingDir(false)
    setPathLocked(false)
  }, [open, isEditMode, spaceId, daemonTarget, loadAgent, applyAgentFields])

  // ：可选目录选择。点按钮才弹 OS 文件夹对话框，检测 .git 预选类型，
  // 名字为空时用目录名兜底。取消选择则保持「用默认沙箱」状态。
  const handlePickDir = useCallback(async () => {
    if (pathLocked) return
    const tabtin = window.tabtin
    if (!tabtin?.showOpenDialog) {
      toast({
        title: t('create.pickDirUnavailable', {
          ns: 'space',
          defaultValue: '文件夹选择器不可用，请稍后重试',
        }),
        variant: 'destructive',
      })
      return
    }
    setIsPickingDir(true)
    let picked: string[] | undefined
    try {
      picked = await tabtin.showOpenDialog({ properties: ['openDirectory'] })
    } catch (err) {
      console.warn('[CreateSpace] showOpenDialog failed', err)
      toast({
        title: t('create.pickDirFailed', {
          ns: 'space',
          defaultValue: '选择目录失败，请重试',
        }),
        variant: 'destructive',
      })
      setIsPickingDir(false)
      return
    }
    if (!picked || picked.length === 0) {
      setIsPickingDir(false)
      return
    }
    // 收敛到物理真实路径再绑定：symlink / junction / 大小写不同写法归一到同一目录，
    // 让后端唯一性约束（Team + control_device + normalized path）能正确拦截重复绑定。
    const dir = await resolveRealPath(picked[0])
    const organizationId = resolveCreateOrganizationId()
    const existing = findLocalWorkingDirConflict({
      organizationId,
      targetWorkingDir: dir,
      excludeSpaceId: isEditMode ? spaceId ?? undefined : undefined,
    })
    let isGitRepo = false
    try {
      const gitApi = tabtin?.git?.isGitRepo
      if (gitApi) {
        const result = await gitApi(dir)
        isGitRepo = !!(result?.success && result?.isRepo)
      }
    } catch (err) {
      console.warn('[CreateSpace] isGitRepo failed, treating as non-repo', err)
    }
    // 冲突时仍写入已选路径：由 occupiedBySpace 派生禁用创建，避免 workingDir
    // 为空回落到 ensureDefaultAgentDir 静默建成功。
    setWorkingDir(dir)
    setWorkingDirType(isGitRepo ? 'code' : 'mixed')
    setName((prev) => (prev.trim() ? prev : getBasename(dir)))
    setFormError(null)
    if (existing) {
      toast({
        title: t('create.workingDirConflictNamed', {
          ns: 'space',
          space: existing.name,
          defaultValue: '该目录已被工作空间「{{space}}」占用，请换一个目录或打开已有工作空间',
        }),
        variant: 'destructive',
      })
    }
    setIsPickingDir(false)
  }, [isEditMode, pathLocked, spaceId, t])

  const handleClearDir = useCallback(() => {
    if (pathLocked) return
    setWorkingDir('')
    setWorkingDirType('mixed')
    setFormError(null)
  }, [pathLocked])

  // 硬规则：本机路径已被占用 → 不允许创建/改绑到该路径（与名字无关）。
  const createBlocker = useMemo(
    () =>
      daemonTarget
        ? { blocked: false as const }
        : getSelectedWorkingDirCreateBlocker({
            organizationId: resolveCreateOrganizationId(),
            selectedWorkingDir: workingDir,
            excludeSpaceId: isEditMode ? spaceId ?? undefined : undefined,
          }),
    [workingDir, isEditMode, spaceId, daemonTarget],
  )
  const occupiedBySpace = createBlocker.blocked ? createBlocker.existing : undefined

  const pathOccupiedMessage = occupiedBySpace
    ? t('create.workingDirConflictNamed', {
        ns: 'space',
        space: occupiedBySpace.name,
        defaultValue: '该目录已被工作空间「{{space}}」占用，请换一个目录或打开已有工作空间',
      })
    : null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (daemonTarget && !isValidRemoteWorkingDir(workingDir)) {
      const message = t('create.remoteWorkingDirInvalid', {
        ns: 'space',
        defaultValue: '请输入执行设备上的非根绝对路径',
      })
      setFormError(message)
      return
    }

    if (occupiedBySpace) {
      const message =
        pathOccupiedMessage ??
        t('create.workingDirConflict', {
          ns: 'space',
          defaultValue: '这个工作目录已绑定到当前设备上的其他工作空间',
        })
      setFormError(message)
      toast({ title: message, variant: 'destructive' })
      return
    }

    setFormError(null)
    setIsCreating(true)
    try {
      const trimmedDesc = description.trim()

      if (isEditMode && spaceId) {
        const spaceState = useSpaceStore.getState()
        const space = spaceState.spaces.find((s) => s.id === spaceId)
        //  / ：保存人设写到当前选中身份
        const agentId = spaceState.selectedAgent?.id ?? null
        const agent = agentId
          ? spaceState.agentCache[agentId] ?? spaceState.selectedAgent
          : null

        if (!space) {
          toast({
            title: t('edit.loadFailed', {
              ns: 'space',
              defaultValue: '无法加载工作空间信息，请稍后重试',
            }),
            variant: 'destructive',
          })
          return
        }

        const trimmedRules = customRules.trim()
        if (!agent && trimmedRules) {
          toast({
            title: t('edit.loadFailed', {
              ns: 'space',
              defaultValue: '无法加载 Agent 信息，请稍后重试',
            }),
            variant: 'destructive',
          })
          return
        }

        let ok = true
        const trimmedName = name.trim() || getBasename(workingDir) || space.name
        const savedWorkingDir = space.working_dir ?? ''
        const savedWorkingDirType = resolveWorkingDirType(
          space.working_dir_type,
        )
        // 已绑定路径不可改绑；编辑态只允许改类型（或首次补设空目录）。
        const nextWorkingDir = pathLocked ? savedWorkingDir : workingDir
        const workspaceChanged = (
          trimmedName !== space.name
          || trimmedDesc !== (space.description ?? '')
          || nextWorkingDir !== savedWorkingDir
          || workingDirType !== savedWorkingDirType
        )
        if (workspaceChanged) {
          ok = await updateSpace(space.id, {
            name: trimmedName,
            description: trimmedDesc,
            working_dir: nextWorkingDir,
            working_dir_type: nextWorkingDir ? workingDirType : '',
            device_fingerprint: useDeviceStore.getState().currentDevice?.fingerprint,
          })
        }

        const agentPatch: UpdateAgentRequest = {}
        if (agent && trimmedRules !== (agent.custom_rules ?? '')) {
          agentPatch.custom_rules = trimmedRules
        }

        if (agent && Object.keys(agentPatch).length > 0) {
          const agentOk = await updateAgent(agent.id, agentPatch)
          ok = ok && agentOk
        }

        if (!ok) {
          const storeError = useSpaceStore.getState().error
          if (
            storeError?.includes('NAME_CONFLICT') ||
            storeError?.includes('已存在')
          ) {
            const message = t('create.nameConflict', {
              ns: 'space',
              defaultValue: '已存在同名助手，请换个名字',
            })
            setFormError(message)
            toast({
              title: message,
              variant: 'destructive',
            })
          } else {
            const conflict = await handleWorkingDirConflictResponse({
              spaceId: space.id,
              organizationId: space.organization_id,
              targetWorkingDir: nextWorkingDir,
              storeError,
              t,
            })
            if (conflict === 'opened') {
              onOpenChange(false)
              return
            }
            const message =
              conflict === 'conflict_unresolved' ||
              isWorkingDirConflictError(storeError)
                ? t('create.workingDirConflict', {
                    ns: 'space',
                    defaultValue: '这个工作目录已绑定到当前设备上的其他工作空间',
                  })
                : t('edit.failed', {
                    ns: 'space',
                    defaultValue: '保存失败，请重试',
                  })
            setFormError(message)
            toast({
              title: message,
              variant: 'destructive',
            })
          }
          return
        }

        if (nextWorkingDir !== savedWorkingDir) {
          void notifyWorkspacePathsForSpace(space.id)
        }

        onOpenChange(false)
        toast({
          title: t('edit.success', {
            ns: 'space',
            defaultValue: '工作空间已更新',
          }),
        })
        return
      }

      const organizationId = resolveCreateOrganizationId()
      if (!organizationId) {
        toast({
          title: t('create.errors.organizationRequired', {
            ns: 'space',
            defaultValue: '请先选择组织',
          }),
          variant: 'destructive',
        })
        return
      }

      const currentDeviceId = useDeviceStore.getState().currentDevice?.id ?? null
      if (!daemonTarget && !currentDeviceId) {
        toast({
          title: t('create.errors.deviceRequired', {
            ns: 'space',
            defaultValue: '正在识别本机执行设备，请稍后再试',
          }),
          variant: 'destructive',
        })
        return
      }

      const trimmedNameInput = name.trim()
      const effectiveName = trimmedNameInput
        ? trimmedNameInput
        : workingDir
          ? getBasename(workingDir)
          : generateRandomWorkspaceName()

      let effectiveWorkingDir = workingDir
      const effectiveWorkingDirType: WorkingDirType = workingDir
        ? workingDirType
        : 'mixed'

      if (!effectiveWorkingDir && !daemonTarget) {
        const defaultDir = await window.tabtin?.fileSystem?.ensureDefaultAgentDir({
          organizationName: resolveCreateOrganizationName(organizationId),
          spaceName: effectiveName,
        })
        if (!defaultDir?.success || !defaultDir.path) {
          toast({
            title: t('create.errors.defaultDirFailed', {
              ns: 'space',
              defaultValue: '默认工作目录准备失败，请稍后再试',
            }),
            description: defaultDir?.error,
            variant: 'destructive',
          })
          return
        }
        effectiveWorkingDir = defaultDir.path
      }

      const created = await createSpace({
        organization_id: organizationId,
        name: effectiveName,
        description: description.trim() || undefined,
        device_id: daemonTarget ? undefined : currentDeviceId ?? undefined,
        device_installation_id: daemonTarget?.installationId,
        working_dir: effectiveWorkingDir,
        working_dir_type: effectiveWorkingDirType,
        custom_rules: customRules.trim() || undefined,
      })

      if (!created) {
        const storeError = useSpaceStore.getState().error
        if (daemonTarget) {
          log.error('远端工作空间创建失败', {
            installationId: daemonTarget.installationId,
            reason: storeError ?? 'unknown',
          })
        }
        const conflict = daemonTarget
          ? 'not_conflict'
          : await handleWorkingDirConflictResponse({
              organizationId,
              targetWorkingDir: effectiveWorkingDir,
              storeError,
              t,
            })
        if (conflict === 'opened') {
          onOpenChange(false)
          return
        }
        const message =
          conflict === 'conflict_unresolved' ||
          isWorkingDirConflictError(storeError)
            ? t('create.workingDirConflict', {
                ns: 'space',
                defaultValue: '这个工作目录已绑定到当前设备上的其他工作空间',
              })
            : t('create.failed', {
                ns: 'space',
                defaultValue: '创建失败，请重试',
              })
        setFormError(message)
        toast({
          title: message,
          variant: 'destructive',
        })
        return
      }

      setName('')
      setDescription('')
      setCustomRules('')
      if (daemonTarget) {
        log.info('远端工作空间创建成功', {
          workspaceId: created.id,
          installationId: daemonTarget.installationId,
        })
      }
      await refreshSpace(created.id)
      const onCreated = useSpaceAgentDialogStore.getState().createOptions?.onCreated
      onOpenChange(false)
      if (onCreated) {
        onCreated(created.id)
        return
      }
      // 选中后显式进「新任务」：仅 selectSpace 时，org 合并会话列表会让
      // reconcile 误判 noop，停在旧对话（看起来像没自动点开新对话）。
      await openCreatedWorkspaceAsNewTask(created.id, {
        organizationId,
        failureToast: {
          title: t('create.createdButNotOpened', {
            ns: 'space',
            defaultValue: '工作空间已创建，但未能自动打开',
          }),
          description: t('create.createdButNotOpenedDesc', {
            ns: 'space',
            defaultValue: '你可以稍后从侧边栏手动进入该工作空间',
          }),
          variant: 'destructive',
        },
      })
    } catch (error) {
      log.error('工作空间创建或更新异常', {
        remote: Boolean(daemonTarget),
        reason: error instanceof Error ? error.message : String(error),
      })
      const message = t('create.failed', {
        ns: 'space',
        defaultValue: '创建失败，请重试',
      })
      setFormError(message)
      toast({
        title: message,
        variant: 'destructive',
      })
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* container={null} 覆盖 OverlayContainerContext：创建 Space 是全局流程，
          不应被 SpaceWorkbenchHost / 画布区的 scoped overlay 限制在内容区内。 */}
      <DialogContent container={null} className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="flex min-h-0 flex-col">
          <ContextDialogHeader
            className="px-0 pt-0"
            icon={
              isEditMode ? (
                <Settings2 className="h-7 w-7" />
              ) : (
                <FolderPlus className="h-7 w-7" />
              )
            }
            title={
              isEditMode
                ? t('edit.title', { ns: 'space', defaultValue: '编辑 Space' })
                : t('create.title', { ns: 'space' })
            }
            description={
              isEditMode
                ? t('edit.description', {
                    ns: 'space',
                    defaultValue:
                      '修改 Space 的名称、描述、自定义规则和工作目录。',
                  })
                : daemonTarget
                  ? t('create.remoteDescription', {
                      ns: 'space',
                      device: daemonTarget.deviceName,
                      defaultValue:
                        '为 {{device}} 创建工作空间，并指定该设备上的工作目录。',
                    })
                : t('create.description', { ns: 'space' })
            }
          />
          <TooltipProvider delayDuration={200}>
            <DialogScrollBody className="space-y-5 py-4">
              <div className="space-y-2">
                <label htmlFor="space-name" className="text-body font-medium">
                  {t('create.fields.name', { ns: 'space' })}
                </label>
                <div className="relative">
                  <Input
                    id="space-name"
                    className="pr-14"
                    placeholder={t('create.fields.namePlaceholder', {
                      ns: 'space',
                    })}
                    value={name}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setName(e.target.value)
                    }
                    maxLength={100}
                    disabled={isCreating}
                    autoFocus
                  />
                  {name.length > 50 && (
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-caption text-muted-foreground/40 pointer-events-none">
                      {name.length}/100
                    </span>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="space-description"
                  className="text-body font-medium"
                >
                  {t('create.fields.description', { ns: 'space' })}
                </label>
                <Input
                  id="space-description"
                  placeholder={t('create.fields.descriptionPlaceholder', {
                    ns: 'space',
                  })}
                  value={description}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setDescription(e.target.value)
                  }
                  disabled={isCreating}
                />
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <label
                    htmlFor="space-custom-rules"
                    className="flex items-center gap-1.5 text-body font-medium"
                  >
                    {t('fields.customRules', {
                      ns: 'space',
                      defaultValue: '自定义规则',
                    })}
                  </label>
                  <FieldHintTooltip
                      label={t('fields.customRulesHintLabel', {
                        ns: 'space',
                        defaultValue: '查看自定义规则说明',
                      })}
                      content={t('fields.customRulesHint', { ns: 'space' })}
                  />
                </div>
                <Textarea
                    id="space-custom-rules"
                    placeholder={t('fields.customRulesPlaceholder', {
                      ns: 'space',
                    })}
                    value={customRules}
                    onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                      setCustomRules(e.target.value)
                    }
                    maxLength={5000}
                    rows={3}
                    disabled={isCreating}
                    className="resize-none border-0 bg-muted focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60"
                  />
              </div>
              {daemonTarget ? (
                <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2">
                  <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-caption text-muted-foreground">
                      {t('create.executionDevice', {
                        ns: 'space',
                        defaultValue: '执行设备',
                      })}
                    </p>
                    <p className="truncate text-body font-medium">
                      {daemonTarget.deviceName}
                    </p>
                  </div>
                </div>
              ) : null}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <span className="flex items-center gap-1.5 text-body font-medium">
                    {t('create.fields.workingDir', {
                      ns: 'space',
                      defaultValue: '工作目录',
                    })}
                    {!daemonTarget ? (
                      <span className="text-caption font-normal text-muted-foreground/60">
                        ({t('create.fields.optional', { ns: 'space' })})
                      </span>
                    ) : null}
                  </span>
                  <FieldHintTooltip
                    label={t('create.workingDirHintLabel', {
                      ns: 'space',
                      defaultValue: '查看工作目录说明',
                    })}
                    content={
                      daemonTarget
                        ? t('create.remoteWorkingDirHint', {
                            ns: 'space',
                            defaultValue:
                              '输入执行设备上已存在的非根绝对路径。控制端不会伪造远程目录浏览。',
                          })
                        : workingDir
                        ? t('create.workingDirHint', {
                            ns: 'space',
                            defaultValue:
                              'Agent 会在这个目录里跑命令、读写文件。目录类型决定这个工作空间默认怎么做事、也决定起始页默认视图，之后可在工作空间设置里改类型；工作目录创建后不可更换。它不会改变「授权策略」里的权限。',
                          })
                        : t('create.workingDirDefaultHint', {
                            ns: 'space',
                            defaultValue:
                              '可选。不选时会在当前组织目录下自动创建工作文件夹；选了文件夹后名称不填时会使用文件夹名。',
                          })
                    }
                  />
                </div>
                {daemonTarget ? (
                  <Input
                    id="daemon-working-dir"
                    value={workingDir}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      setWorkingDir(event.target.value)
                      setFormError(null)
                    }}
                    placeholder={t('create.remoteWorkingDirPlaceholder', {
                      ns: 'space',
                      defaultValue: '/home/user/project',
                    })}
                    disabled={isCreating}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                ) : !workingDir ? (
                  <UIButton
                    type="button"
                    variant="outline"
                    onClick={handlePickDir}
                    disabled={isCreating || isPickingDir}
                    className="h-9 w-full justify-start gap-2 text-muted-foreground"
                  >
                    {isPickingDir ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <FolderPlus className="h-3.5 w-3.5" />
                    )}
                    {t('create.pickDir', {
                      ns: 'space',
                      defaultValue: '选择文件夹…',
                    })}
                  </UIButton>
                ) : (
                  <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/20 px-3 py-2 text-caption text-muted-foreground/90">
                    <Folder className="h-3.5 w-3.5 shrink-0" />
                    <span className="font-mono truncate" title={workingDir}>
                      {workingDir}
                    </span>
                    {!pathLocked ? (
                      <button
                        type="button"
                        onClick={handleClearDir}
                        disabled={isCreating || isPickingDir}
                        className="ml-auto shrink-0 rounded p-0.5 text-muted-foreground/60 hover:text-foreground hover:bg-muted/40 transition-colors"
                        title={t('create.clearDir', {
                          ns: 'space',
                          defaultValue: '清除已选目录',
                        })}
                        aria-label={t('create.clearDir', {
                          ns: 'space',
                          defaultValue: '清除已选目录',
                        })}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                  </div>
                )}
                {workingDir ? (
                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {(
                      [
                        {
                          value: 'code',
                          label: t('create.workingDirType.code', {
                            ns: 'space',
                            defaultValue: '代码',
                          }),
                          hint: t('create.workingDirType.codeHint', {
                            ns: 'space',
                            defaultValue: '代码为主，偏稳妥',
                          }),
                          Icon: Code2,
                        },
                        {
                          value: 'mixed',
                          label: t('create.workingDirType.mixed', {
                            ns: 'space',
                            defaultValue: '混合',
                          }),
                          hint: t('create.workingDirType.mixedHint', {
                            ns: 'space',
                            defaultValue: '代码文档兼顾',
                          }),
                          Icon: Folder,
                        },
                        {
                          value: 'doc',
                          label: t('create.workingDirType.doc', {
                            ns: 'space',
                            defaultValue: '文档',
                          }),
                          hint: t('create.workingDirType.docHint', {
                            ns: 'space',
                            defaultValue: '文档为主，重表达',
                          }),
                          Icon: FileText,
                        },
                      ] as Array<{
                        value: WorkingDirType
                        label: string
                        hint: string
                        Icon: React.FC<{ className?: string }>
                      }>
                    ).map(({ value, label, hint, Icon }) => {
                      const active = workingDirType === value
                      return (
                        <button
                          key={value}
                          type="button"
                          onClick={() => setWorkingDirType(value)}
                          disabled={isCreating}
                          title={hint}
                          className={cn(
                            'flex flex-col items-center gap-1 rounded-md border px-3 py-2 transition-colors text-center',
                            active
                              ? 'border-accent bg-accent/10 text-foreground'
                              : 'border-border/40 bg-muted/10 text-muted-foreground hover:border-accent/40 hover:bg-accent/5',
                          )}
                        >
                          <Icon
                            className={cn(
                              'h-3.5 w-3.5',
                              active && 'text-accent',
                            )}
                          />
                          <span className="text-caption font-medium">
                            {label}
                          </span>
                          <span className="text-caption text-muted-foreground/60 leading-tight">
                            {hint}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
              </div>
              {pathOccupiedMessage || formError ? (
                <p
                  role="alert"
                  className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-caption text-destructive"
                >
                  {pathOccupiedMessage || formError}
                </p>
              ) : null}
            </DialogScrollBody>
          </TooltipProvider>
          <DialogFooter className="gap-2">
            <UIButton
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isCreating}
            >
              {t('cancel', { ns: 'common' })}
            </UIButton>
            <UIButton
              type="submit"
              disabled={isCreating || Boolean(occupiedBySpace)}
              className="bg-accent hover:bg-accent/90"
            >
              {isCreating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : isEditMode ? (
                <Settings2 className="h-4 w-4 mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              {isEditMode
                ? t('edit.actions.save', {
                    ns: 'space',
                    defaultValue: '保存更改',
                  })
                : t('create.actions.create', { ns: 'space' })}
            </UIButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { CreateSpaceDialog }
